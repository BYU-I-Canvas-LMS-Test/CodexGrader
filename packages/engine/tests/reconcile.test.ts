// Resume/reconcile matrix (port of GradingRunEngine.ResumeRunAsync — plan
// §"Resume flow"):
//   EXTRACTING/SCORING → PENDING requeue (drafts are cheap; re-grading safe)
//   PENDING            → requeue
//   APPROVED w/o PostedAt + Canvas score+gradedAt match ⇒ POSTED, never re-post
//   APPROVED w/o PostedAt + mismatch ⇒ writeback re-queued (posts exactly once)
//   POSTED             → untouched
//   resubmitted-since-graded ⇒ errorMessage flag
// Quiz: in-flight rows requeue; APPROVED groups re-post (idempotent PUT).

import { describe, expect, it } from 'vitest';
import type { QuizQuestionGradeEntry } from '@aigrader/shared';
import {
  FakeCanvas,
  buildEngine,
  graderOutputJson,
  makeGrade,
  makeProgressDoc,
  makeRunDoc,
  shutdown,
  student,
  textSubmission,
} from './engine-helpers.js';

const CHECKPOINT_UPDATED_AT = '2026-06-10T15:00:00.000Z';

function quizEntry(
  overrides: Partial<QuizQuestionGradeEntry> & {
    canvasUserId: number;
    quizSubmissionId: number;
    questionId: number;
  },
): QuizQuestionGradeEntry {
  return {
    studentName: `Student ${overrides.canvasUserId}`,
    attempt: 1,
    questionName: `Q${overrides.questionId}`,
    maxPoints: 10,
    status: 'PENDING',
    answerExcerpt: null,
    aiDraft: null,
    facultyEdited: null,
    errorMessage: null,
    postedAt: null,
    updatedAt: CHECKPOINT_UPDATED_AT,
    ...overrides,
  };
}

describe('assignment reconcile matrix', () => {
  it('requeues in-flight rows, reconciles APPROVED against Canvas, never touches POSTED', async () => {
    const canvas = new FakeCanvas();
    canvas.students = [1, 2, 3, 4, 5, 6].map((id) => student(id));
    canvas.submissions = [
      textSubmission(1, '<p>one</p>'), // EXTRACTING → PENDING → regraded
      textSubmission(2, '<p>two</p>'), // SCORING → PENDING → regraded
      textSubmission(3, '<p>three</p>'), // PENDING → regraded
      // 4: APPROVED w/o PostedAt; Canvas ALREADY has the matching score,
      // graded after the checkpoint ⇒ mark POSTED, no re-post.
      textSubmission(4, '<p>four</p>', {
        workflow_state: 'graded',
        score: 18,
        graded_at: '2026-06-10T15:02:00Z',
      }),
      // 5: APPROVED w/o PostedAt; Canvas score DIFFERS ⇒ writeback re-queued.
      textSubmission(5, '<p>five</p>', {
        workflow_state: 'graded',
        score: 3,
        graded_at: '2026-06-10T15:02:00Z',
      }),
      // 6: already POSTED; also RESUBMITTED after grading (submitted_at newer).
      textSubmission(6, '<p>six</p>', {
        workflow_state: 'submitted',
        submitted_at: '2026-06-10T15:30:00Z',
      }),
    ];

    const approvedDraft = {
      totalPoints: '18/20',
      assignmentFeedback: 'ok',
      rubrics: [],
    };
    const checkpoint = makeRunDoc({
      status: 'RUNNING',
      updatedAt: CHECKPOINT_UPDATED_AT,
      startedAt: '2026-06-10T14:30:00.000Z',
      grades: [
        makeGrade({ canvasUserId: 1, status: 'EXTRACTING' }),
        makeGrade({ canvasUserId: 2, status: 'SCORING' }),
        makeGrade({ canvasUserId: 3, status: 'PENDING' }),
        makeGrade({ canvasUserId: 4, status: 'APPROVED', aiDraft: approvedDraft }),
        makeGrade({ canvasUserId: 5, status: 'APPROVED', aiDraft: approvedDraft }),
        makeGrade({
          canvasUserId: 6,
          status: 'POSTED',
          postedAt: '2026-06-10T14:50:00.000Z',
          submittedAt: '2026-06-09T10:00:00Z',
          aiDraft: approvedDraft,
        }),
      ],
    });

    const harness = buildEngine({ canvas });
    harness.runStore.docs.set('run1', checkpoint);
    harness.progressStore.docs.set('run1', makeProgressDoc());

    const result = await harness.engine.resume('run1');
    expect(result).toMatchObject({ outcome: 'resumed', requeued: 3, writebacks: 1 });

    const doc = harness.registry.get('run1')!.session.document;
    expect(doc.status).toBe('RUNNING'); // requeued work ⇒ RUNNING

    // 4 reconciled as already-posted — postedAt taken from Canvas graded_at.
    const row4 = doc.grades.find((g) => g.canvasUserId === 4)!;
    expect(row4.status).toBe('POSTED');
    expect(row4.postedAt).toBe('2026-06-10T15:02:00.000Z');

    await harness.engine.onIdle();

    // 1/2/3 re-graded to DRAFT.
    for (const id of [1, 2, 3]) {
      expect(doc.grades.find((g) => g.canvasUserId === id)!.status).toBe('DRAFT');
    }
    // 5 posted exactly once (the score-mismatch writeback).
    expect(harness.canvas.postedGrades.map((p) => p.userId)).toEqual([5]);
    const row5 = doc.grades.find((g) => g.canvasUserId === 5)!;
    expect(row5.status).toBe('POSTED');

    // 6 untouched — same postedAt, no duplicate post, but flagged resubmitted.
    const row6 = doc.grades.find((g) => g.canvasUserId === 6)!;
    expect(row6.status).toBe('POSTED');
    expect(row6.postedAt).toBe('2026-06-10T14:50:00.000Z');
    expect(row6.errorMessage).toBe(
      'Student resubmitted after this draft was graded — consider re-running.',
    );

    // Progress reflects the resume.
    expect(harness.progressStore.docs.get('run1')!.worker.resumeCount).toBe(1);
    expect(harness.progressStore.docs.get('run1')!.worker.owner).toBe('test:me');

    await shutdown(harness);
  });

  it('APPROVED score-match but graded BEFORE the checkpoint window ⇒ re-queued (stale grade)', async () => {
    const canvas = new FakeCanvas();
    canvas.students = [student(1)];
    canvas.submissions = [
      // Score matches but graded_at is far older than checkpoint−5min: that
      // grade predates this run — the crash did NOT post it.
      textSubmission(1, '<p>one</p>', {
        workflow_state: 'graded',
        score: 18,
        graded_at: '2026-06-01T00:00:00Z',
      }),
    ];
    const checkpoint = makeRunDoc({
      status: 'POSTING',
      updatedAt: CHECKPOINT_UPDATED_AT,
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'APPROVED',
          aiDraft: { totalPoints: '18/20', assignmentFeedback: 'ok', rubrics: [] },
        }),
      ],
    });
    const harness = buildEngine({ canvas });
    harness.runStore.docs.set('run1', checkpoint);
    harness.progressStore.docs.set('run1', makeProgressDoc());

    const result = await harness.engine.resume('run1');
    expect(result).toMatchObject({ outcome: 'resumed', requeued: 0, writebacks: 1 });
    await harness.engine.onIdle();
    expect(harness.canvas.postedGrades.map((p) => p.userId)).toEqual([1]);
    await shutdown(harness);
  });

  it('nothing to requeue ⇒ REVIEWING', async () => {
    const canvas = new FakeCanvas();
    canvas.students = [student(1)];
    canvas.submissions = [textSubmission(1, '<p>one</p>')];
    const checkpoint = makeRunDoc({
      status: 'RUNNING',
      updatedAt: CHECKPOINT_UPDATED_AT,
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'DRAFT',
          aiDraft: { totalPoints: '10/20', assignmentFeedback: 'ok', rubrics: [] },
        }),
      ],
    });
    const harness = buildEngine({ canvas });
    harness.runStore.docs.set('run1', checkpoint);
    harness.progressStore.docs.set('run1', makeProgressDoc());

    const result = await harness.engine.resume('run1');
    expect(result).toMatchObject({ outcome: 'resumed', requeued: 0, writebacks: 0 });
    expect(harness.registry.get('run1')!.session.document.status).toBe('REVIEWING');
    expect(harness.modelCalls).toHaveLength(0); // no re-grading
    await shutdown(harness);
  });

  it('a second resume while live is a no-op (already_live)', async () => {
    const canvas = new FakeCanvas();
    canvas.students = [student(1)];
    canvas.submissions = [textSubmission(1, '<p>one</p>')];
    const harness = buildEngine({ canvas });
    harness.runStore.docs.set(
      'run1',
      makeRunDoc({
        status: 'RUNNING',
        updatedAt: CHECKPOINT_UPDATED_AT,
        grades: [makeGrade({ canvasUserId: 1, status: 'DRAFT' })],
      }),
    );
    harness.progressStore.docs.set('run1', makeProgressDoc());

    await harness.engine.resume('run1');
    await expect(harness.engine.resume('run1')).resolves.toEqual({ outcome: 'already_live' });
    await shutdown(harness);
  });

  it('unknown runs and missing checkpoints surface typed errors', async () => {
    const harness = buildEngine({});
    await expect(harness.engine.resume('nope')).rejects.toMatchObject({ code: 'unknown_run' });

    harness.progressStore.docs.set('run1', makeProgressDoc()); // progress, no checkpoint
    await expect(harness.engine.resume('run1')).rejects.toMatchObject({
      code: 'run_document_missing',
    });
  });
});

describe('quiz reconcile', () => {
  it('requeues in-flight questions and re-posts APPROVED groups (idempotent PUT)', async () => {
    const canvas = new FakeCanvas();
    canvas.students = [student(1), student(2)];
    canvas.quizAnswers.set(100, [{ id: 7, answer: '<p>redone answer</p>' }]);

    const checkpoint = makeRunDoc({
      canvasQuizId: 42,
      status: 'RUNNING',
      updatedAt: CHECKPOINT_UPDATED_AT,
      quizQuestionSnapshot: [
        {
          questionId: 7,
          questionName: 'Q7',
          questionTextHtml: '<p>Explain.</p>',
          maxPoints: 10,
          correctComments: null,
          neutralComments: null,
        },
      ],
      quizGrades: [
        quizEntry({ canvasUserId: 1, quizSubmissionId: 100, questionId: 7, status: 'SCORING' }),
        quizEntry({
          canvasUserId: 2,
          quizSubmissionId: 200,
          questionId: 7,
          status: 'APPROVED',
          aiDraft: { score: 8, comment: 'nice' },
        }),
        quizEntry({
          canvasUserId: 2,
          quizSubmissionId: 200,
          questionId: 8,
          status: 'POSTED',
          postedAt: '2026-06-10T14:50:00.000Z',
          aiDraft: { score: 5, comment: 'done' },
        }),
      ],
    });

    const harness = buildEngine({
      canvas,
      modelCall: async () => ({ text: JSON.stringify({ score: 6, comment: 'redone' }) }),
    });
    harness.runStore.docs.set('run1', checkpoint);
    harness.progressStore.docs.set('run1', makeProgressDoc());

    const result = await harness.engine.resume('run1');
    expect(result).toMatchObject({ outcome: 'resumed', requeued: 1, writebacks: 1 });
    await harness.engine.onIdle();

    const doc = harness.registry.get('run1')!.session.document;
    expect(doc.quizGrades.find((g) => g.quizSubmissionId === 100)!.status).toBe('DRAFT');

    // The approved group re-posted in ONE PUT; the POSTED row stayed out.
    expect(harness.canvas.postedQuizGrades).toHaveLength(1);
    const put = harness.canvas.postedQuizGrades[0]!;
    expect(put.quizSubmissionId).toBe(200);
    expect(Object.keys(put.args.questions)).toEqual(['7']);

    await shutdown(harness);
  });
});
