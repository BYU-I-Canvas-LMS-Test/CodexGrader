// Engine fan-out tests: assignment (submission filters, drafts, llm stats,
// REVIEWING transition, progress counts), quiz (essay-only,
// attempt-required, clamped drafts), discussion (aggregated per-student
// texts, roster intersect), the approve → POSTING → COMPLETED path, error
// containment, and cancel mid-run. Fake model + fake Canvas — no network,
// ever.

import { describe, expect, it } from 'vitest';
import {
  FakeCanvas,
  TEST_COURSE_KEY,
  buildEngine,
  graderOutputJson,
  shutdown,
  student,
  textSubmission,
} from './engine-helpers.js';

const START_ARGS = {
  courseKey: TEST_COURSE_KEY,
  faculty: { canvasUserId: 9, name: 'John Doe' },
};

function assignmentCanvas(): FakeCanvas {
  const canvas = new FakeCanvas();
  canvas.assignment.rubric = [
    {
      id: '_1',
      description: 'Quality',
      long_description: null,
      points: 20,
      learning_outcome_id: null,
      ratings: [
        { id: '_r1', description: 'Full', long_description: null, points: 20 },
        { id: '_r2', description: 'Partial', long_description: null, points: 10 },
      ],
    },
  ];
  canvas.students = [student(1), student(2), student(3), student(4), student(5)];
  const longText = 'wordy '.repeat(700).trim(); // > the 2000-char excerpt cap
  canvas.submissions = [
    textSubmission(1, '<p>Short answer</p>'),
    textSubmission(2, '<p>Already graded</p>', { workflow_state: 'graded' }),
    textSubmission(3, '', { workflow_state: 'unsubmitted', body: null }),
    textSubmission(4, '', { body: null }), // submitted but no content
    {
      ...textSubmission(5, ''),
      body: null,
      submission_type: 'online_upload',
      attachments: [
        {
          id: 71,
          filename: 'essay.txt',
          display_name: 'essay.txt',
          size: longText.length,
          'content-type': 'text/plain',
          mime_class: 'text',
          url: 'https://files.example/5.txt',
          preview_url: null,
        },
      ],
    },
  ];
  canvas.files.set('https://files.example/5.txt', Buffer.from(longText, 'utf8'));
  return canvas;
}

describe('assignment fan-out', () => {
  it('filters submissions, drafts via the model, and reaches REVIEWING', async () => {
    const harness = buildEngine({
      canvas: assignmentCanvas(),
      modelCall: async () => ({
        text: graderOutputJson({
          Rubrics: [{ id: '_1', ratingID: '_r1', points: 18, ratingFeedback: 'solid' }],
        }),
        usage: { inputTokens: 100, outputTokens: 40 },
      }),
    });
    const { engine, registry, runStore, progressStore } = harness;

    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'assignment', assignmentId: 501 },
    });
    expect(runId).toBe('run1');

    const doc = registry.get(runId)!.session.document;
    // Filters: graded (2), unsubmitted (3), and contentless (4) are excluded.
    expect(doc.grades.map((g) => g.canvasUserId).sort()).toEqual([1, 5]);
    expect(doc.rubricSnapshot).toHaveLength(1);
    expect(doc.assignmentName).toBe('Essay 1');
    expect(doc.modelName).toBe('test-model');

    await engine.onIdle();

    const row1 = doc.grades.find((g) => g.canvasUserId === 1)!;
    const row5 = doc.grades.find((g) => g.canvasUserId === 5)!;
    expect(row1.status).toBe('DRAFT');
    expect(row5.status).toBe('DRAFT');
    // Drafts re-keyed to snapshot ids + total synced from criterion sum.
    expect(row1.aiDraft?.rubrics[0]?.criterionId).toBe('_1');
    expect(row1.aiDraft?.totalPoints).toBe('18/20');
    expect(row1.llm).toMatchObject({ inputTokens: 100, outputTokens: 40 });
    // 2000-char excerpt cap.
    expect(row5.submissionExcerpt).toHaveLength(2000);
    expect(row5.excerptTruncated).toBe(true);

    // All rows drafted ⇒ REVIEWING (immediate flush + progress write).
    expect(doc.status).toBe('REVIEWING');
    expect(runStore.lastSave.status).toBe('REVIEWING');
    expect(runStore.lastSave.lock?.owner).toBe('test:me');

    const progress = progressStore.last;
    expect(progress.status).toBe('REVIEWING');
    expect(progress.counts).toMatchObject({ total: 2, drafted: 2, errors: 0, posted: 0 });
    expect(progress.courseKey).toBe(TEST_COURSE_KEY);

    await shutdown(harness);
  });

  it('approve → POSTING → posts with the prefix → COMPLETED + terminal bookkeeping', async () => {
    const harness = buildEngine({
      canvas: assignmentCanvas(),
      modelCall: async () => ({
        text: graderOutputJson({
          Rubrics: [{ id: '_1', ratingID: '_r1', points: 18, ratingFeedback: 'solid' }],
        }),
      }),
    });
    const { engine, canvas, registry, progressStore } = harness;

    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'assignment', assignmentId: 501 },
    });
    await engine.onIdle();

    const { approved } = await engine.approve(runId, { all: true, approver: { canvasUserId: 9, name: "Jane Approver" } });
    expect(approved).toBe(2);
    await engine.onIdle();

    expect(canvas.postedGrades).toHaveLength(2);
    // The prefix names the APPROVER (not the run starter, John Doe).
    for (const post of canvas.postedGrades) {
      expect(
        (post.args as { comment: string }).comment.startsWith('[As Reviewed by Jane Approver]'),
      ).toBe(true);
    }

    // COMPLETED is terminal: session unregistered, final progress record
    // written (and no longer listed as live).
    expect(registry.get(runId)).toBeUndefined();
    const progress = progressStore.docs.get(runId)!;
    expect(progress.status).toBe('COMPLETED');
    expect(progress.counts.posted).toBe(2);
    expect(await progressStore.listLive()).toHaveLength(0);

    // Snapshot still serves from the Canvas checkpoint after removal.
    const snapshot = await engine.getSnapshot(runId);
    expect(snapshot.status).toBe('COMPLETED');
    expect(snapshot.grades.every((g) => g.status === 'POSTED' && g.postedAt != null)).toBe(true);
  });

  it('a transient download failure lands ONLY that row in ERROR (re-runnable)', async () => {
    const canvas = assignmentCanvas();
    canvas.files.delete('https://files.example/5.txt'); // download now fails
    const harness = buildEngine({ canvas });
    const { engine, registry, progressStore } = harness;

    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'assignment', assignmentId: 501 },
    });
    await engine.onIdle();

    const doc = registry.get(runId)!.session.document;
    expect(doc.grades.find((g) => g.canvasUserId === 1)!.status).toBe('DRAFT');
    const errRow = doc.grades.find((g) => g.canvasUserId === 5)!;
    expect(errRow.status).toBe('ERROR');
    expect(errRow.errorMessage).toContain('download failed');
    expect(doc.status).toBe('REVIEWING'); // errors are terminal-enough for review
    expect(progressStore.last.counts).toMatchObject({ drafted: 1, errors: 1 });

    await shutdown(harness);
  });
});

describe('quiz fan-out', () => {
  function quizCanvas(): FakeCanvas {
    const canvas = new FakeCanvas();
    canvas.assignment = { ...canvas.assignment, submission_types: ['online_quiz'], quiz_id: 42 };
    canvas.students = [student(1), student(2), student(3)];
    canvas.quizQuestions = [
      {
        id: 7,
        position: 1,
        question_type: 'essay_question',
        question_name: 'Explain X',
        question_text: '<p>Explain X.</p>',
        points_possible: 5,
        correct_comments: 'Mentions X',
        neutral_comments: null,
      },
      {
        id: 8,
        position: 2,
        question_type: 'multiple_choice_question',
        question_name: 'MC',
        question_text: '<p>Pick one.</p>',
        points_possible: 1,
        correct_comments: null,
        neutral_comments: null,
      },
      {
        id: 9,
        position: 3,
        question_type: 'essay_question',
        question_name: '',
        question_text: '<p>Explain Y.</p>',
        points_possible: 10,
        correct_comments: null,
        neutral_comments: null,
      },
    ];
    canvas.quizSubmissions = [
      { id: 100, user_id: 1, attempt: 2, submitted_at: null, workflow_state: 'complete' },
      { id: 200, user_id: 2, attempt: null, submitted_at: null, workflow_state: 'complete' }, // no attempt № — excluded
      { id: 300, user_id: 3, attempt: 1, submitted_at: null, workflow_state: 'untaken' }, // untaken — excluded
    ];
    canvas.quizAnswers.set(100, [
      { id: 7, answer: '<p>Because X causes Y.</p>' },
      { id: 9, answer: '' }, // blank ⇒ row ERROR
    ]);
    return canvas;
  }

  it('fans out essay questions × taken attempts and clamps scores', async () => {
    const harness = buildEngine({
      canvas: quizCanvas(),
      modelCall: async () => ({
        text: JSON.stringify({ score: 7, comment: 'good reasoning' }), // over the 5-point max
      }),
    });
    const { engine, registry, progressStore } = harness;

    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'quiz', assignmentId: 501, quizId: 42 },
    });

    const doc = registry.get(runId)!.session.document;
    expect(doc.canvasQuizId).toBe(42);
    // Essay-only snapshot (MC question excluded); blank names defaulted.
    expect(doc.quizQuestionSnapshot.map((q) => q.questionId)).toEqual([7, 9]);
    expect(doc.quizQuestionSnapshot[1]!.questionName).toBe('Question 3');
    // One taken attempt × 2 essay questions.
    expect(doc.quizGrades).toHaveLength(2);
    expect(doc.quizGrades.every((g) => g.quizSubmissionId === 100 && g.attempt === 2)).toBe(true);

    await engine.onIdle();

    const q7 = doc.quizGrades.find((g) => g.questionId === 7)!;
    const q9 = doc.quizGrades.find((g) => g.questionId === 9)!;
    expect(q7.status).toBe('DRAFT');
    expect(q7.aiDraft).toMatchObject({ score: 5 }); // clamped to maxPoints
    expect(q7.answerExcerpt).toBe('Because X causes Y.');
    expect(q9.status).toBe('ERROR');
    expect(q9.errorMessage).toContain('blank');

    expect(doc.status).toBe('REVIEWING');
    expect(progressStore.last.counts).toMatchObject({ total: 2, drafted: 1, errors: 1 });

    await shutdown(harness);
  });

  it('refuses a quiz with no essay questions', async () => {
    const canvas = quizCanvas();
    canvas.quizQuestions = canvas.quizQuestions.filter((q) => q.question_type !== 'essay_question');
    const harness = buildEngine({ canvas });

    await expect(
      harness.engine.startRun({
        ...START_ARGS,
        target: { kind: 'quiz', assignmentId: 501, quizId: 42 },
      }),
    ).rejects.toMatchObject({ code: 'quiz_has_no_essay_questions' });
  });
});

describe('discussion fan-out', () => {
  it('aggregates per-student posts, intersects the roster, and grades the aggregate', async () => {
    const canvas = new FakeCanvas();
    canvas.assignment = {
      ...canvas.assignment,
      submission_types: ['discussion_topic'],
      discussion_topic: { id: 55, title: 'Week 1' },
    };
    canvas.students = [student(1), student(2), student(3)];
    canvas.discussionEntries = [
      { id: 1, user_id: 1, parent_id: null, created_at: '2026-06-01T10:00:00Z', message: '<p>First post</p>' },
      { id: 2, user_id: 999, parent_id: null, created_at: '2026-06-01T11:00:00Z', message: '<p>Instructor post</p>' },
      { id: 3, user_id: 1, parent_id: 2, created_at: '2026-06-02T09:30:00Z', message: '<p>A reply</p>' },
      { id: 4, user_id: 3, parent_id: null, created_at: '2026-06-01T12:00:00Z', message: '   ' },
    ];
    canvas.submissions = [
      textSubmission(2, '<p>x</p>', { workflow_state: 'graded' }), // user 2 already graded
    ];

    const harness = buildEngine({ canvas });
    const { engine, registry, modelCalls } = harness;

    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'discussion', assignmentId: 501, discussionId: 55 },
    });

    const doc = registry.get(runId)!.session.document;
    expect(doc.canvasDiscussionTopicId).toBe(55);
    // 999 is not on the roster; user 3 posted only whitespace; user 2 never
    // posted (graded filter is moot). Only user 1 grades.
    expect(doc.grades.map((g) => g.canvasUserId)).toEqual([1]);
    expect(doc.grades[0]!.submissionType).toBe('discussion_topic');

    await engine.onIdle();

    expect(doc.grades[0]!.status).toBe('DRAFT');
    expect(doc.status).toBe('REVIEWING');

    // The aggregated text (chronological, labeled) reached the prompt.
    const call = modelCalls[0] as { userText: string };
    const userText = call.userText;
    expect(userText).toContain('[Post 1 — Jun 1, 2026 10:00 AM]\nFirst post');
    expect(userText).toContain('[Reply 2 — Jun 2, 2026 9:30 AM]\nA reply');

    await shutdown(harness);
  });
});

describe('faculty edit via the engine', () => {
  it('records the edit on the live session (EDITED status, edit flush tier armed)', async () => {
    const harness = buildEngine({ canvas: assignmentCanvas() });
    const { engine, registry } = harness;
    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'assignment', assignmentId: 501 },
    });
    await engine.onIdle();

    await engine.edit(runId, {
      canvasUserId: 1,
      facultyEdited: { totalPoints: '20/20', assignmentFeedback: 'perfect', rubrics: [] },
    });

    const live = registry.get(runId)!;
    const row = live.session.document.grades.find((g) => g.canvasUserId === 1)!;
    expect(row.status).toBe('EDITED');
    expect(row.facultyEdited?.totalPoints).toBe('20/20');
    expect(live.session.hasPendingChanges).toBe(true); // ~3s tier armed

    await shutdown(harness);
  });
});

describe('cancel mid-run', () => {
  it('aborts in-flight calls, skips queued items, and finalizes CANCELLED', async () => {
    const canvas = new FakeCanvas();
    canvas.students = [student(1), student(2), student(3)];
    canvas.submissions = [
      textSubmission(1, '<p>a</p>'),
      textSubmission(2, '<p>b</p>'),
      textSubmission(3, '<p>c</p>'),
    ];

    // Model calls hang until aborted (the AbortController seam).
    let inFlight = 0;
    const harness = buildEngine({
      canvas,
      modelCall: (request) =>
        new Promise((_resolve, reject) => {
          inFlight++;
          request.signal.addEventListener('abort', () => reject(new Error('aborted by test')), {
            once: true,
          });
        }),
    });
    const { engine, registry, runStore, progressStore } = harness;

    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'assignment', assignmentId: 501 },
    });
    const doc = registry.get(runId)!.session.document;

    // Wait until all three rows are mid-LLM-call.
    while (inFlight < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(doc.grades.every((g) => g.status === 'SCORING')).toBe(true);

    const result = await engine.cancel(runId);
    expect(result.status).toBe('cancelled');
    await engine.onIdle();

    // Rows are left in-flight (NOT forced to ERROR); nothing posted; run doc
    // is CANCELLED with an immediate flush.
    expect(doc.status).toBe('CANCELLED');
    expect(doc.grades.every((g) => g.status === 'SCORING')).toBe(true);
    expect(canvas.postedGrades).toHaveLength(0);
    expect(runStore.lastSave.status).toBe('CANCELLED');

    // Terminal bookkeeping: unregistered, progress terminal + cancel ack.
    expect(registry.get(runId)).toBeUndefined();
    const progress = progressStore.docs.get(runId)!;
    expect(progress.status).toBe('CANCELLED');
    expect(progress.cancelRequested).toBe(true);
    expect(await progressStore.listLive()).toHaveLength(0);
  });

  it('cancelling a run whose process is gone just flags it for the resume sweep', async () => {
    const harness = buildEngine({ canvas: assignmentCanvas() });
    const { engine, registry, progressStore } = harness;
    const { runId } = await engine.startRun({
      ...START_ARGS,
      target: { kind: 'assignment', assignmentId: 501 },
    });
    await engine.onIdle();
    // Simulate the owner dying: unregister without terminal bookkeeping.
    await registry.remove(runId);

    const result = await engine.cancel(runId);
    expect(result.status).toBe('flagged');
    expect(progressStore.docs.get(runId)!.cancelRequested).toBe(true);
  });
});
