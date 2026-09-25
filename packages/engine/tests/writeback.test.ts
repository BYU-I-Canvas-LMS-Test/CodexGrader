// WritebackService tests: the EXACT "[As Reviewed by {name}]" prefix (parity
// contract), the PostedAt idempotency gate (a
// re-queued post never double-posts), the immediate flush after a successful
// post, faculty-edit precedence, the SyncTotalPoints truth guard, and the
// quiz path's grouped single PUT.

import { describe, expect, it } from 'vitest';
import type { QuizQuestionGradeEntry } from '@aigrader/shared';
import { RunSession } from '../src/coordinator/run-session.js';
import {
  AI_ASSISTED_PREFIX_FORMAT,
  POST_FAILED_MESSAGE,
  WritebackService,
  aiAssistedPrefix,
  prefixedComment,
} from '../src/grading/writeback.js';
import {
  FakeCanvas,
  FakeRunStore,
  TestClock,
  makeGrade,
  makeRunDoc,
  textSubmission,
} from './engine-helpers.js';

const textSubmissionFor = (userId: number) => textSubmission(userId, '<p>x</p>');

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
    status: 'APPROVED',
    answerExcerpt: null,
    aiDraft: null,
    facultyEdited: null,
    errorMessage: null,
    postedAt: null,
    updatedAt: '2026-06-10T15:00:00.000Z',
    ...overrides,
  };
}

function build(docOverrides = {}) {
  const clock = new TestClock();
  const store = new FakeRunStore();
  const canvas = new FakeCanvas();
  const doc = makeRunDoc(docOverrides);
  const session = new RunSession({
    document: doc,
    store,
    now: clock.now,
    startLoop: false,
    warn: () => {},
  });
  const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
  const service = new WritebackService({
    canvas,
    auditFn: ((action: string, fields: Record<string, unknown> = {}) => {
      audits.push({ action, fields });
    }) as never,
    warn: () => {},
  });
  return { clock, store, canvas, doc, session, service, audits };
}

describe('the prefix contract', () => {
  it('is the exact C# AiAssistedPrefixFormat', () => {
    expect(AI_ASSISTED_PREFIX_FORMAT).toBe('[As Reviewed by {0}]');
    expect(aiAssistedPrefix('John Doe')).toBe('[As Reviewed by John Doe]');
    expect(prefixedComment('John Doe', 'Great work.')).toBe(
      '[As Reviewed by John Doe] Great work.',
    );
    expect(prefixedComment('John Doe', '')).toBe('[As Reviewed by John Doe]');
    expect(prefixedComment('John Doe', null)).toBe('[As Reviewed by John Doe]');
  });
});

describe('assignment writeback', () => {
  it('posts score + prefixed comment + rubric assessment, marks POSTED, and flushes IMMEDIATELY', async () => {
    const { store, canvas, doc, session, service, audits } = build({
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'APPROVED',
          aiDraft: {
            totalPoints: '18/20',
            assignmentFeedback: 'Great work.',
            rubrics: [
              { criterionId: '_4692', ratingId: '_r1', points: 18, ratingFeedback: 'solid' },
            ],
          },
        }),
      ],
    });

    await service.postOne(session, { canvasUserId: 1 });

    expect(canvas.postedGrades).toHaveLength(1);
    const post = canvas.postedGrades[0]!;
    expect(post.userId).toBe(1);
    expect(post.args).toMatchObject({
      postedGrade: '18/20',
      comment: '[As Reviewed by John Doe] Great work.',
      rubricAssessment: { _4692: { points: 18, comments: 'solid' } },
    });

    const row = doc.grades[0]!;
    expect(row.status).toBe('POSTED');
    expect(row.postedAt).not.toBeNull();
    // The immediate flush recorded PostedAt durably.
    expect(store.saves).toHaveLength(1);
    expect(store.lastSave.grades[0]!.postedAt).not.toBeNull();
    expect(audits.map((a) => a.action)).toEqual(['GradePosted']);
  });

  it('REFUSES to double-post: PostedAt set ⇒ no Canvas call, no matter the re-queue', async () => {
    const { canvas, session, service } = build({
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'APPROVED',
          postedAt: '2026-06-10T15:30:00.000Z',
          aiDraft: { totalPoints: '18/20', assignmentFeedback: 'x', rubrics: [] },
        }),
      ],
    });
    await service.postOne(session, { canvasUserId: 1 });
    expect(canvas.postedGrades).toHaveLength(0);
  });

  it('refuses non-APPROVED rows (a DRAFT can never slip out)', async () => {
    const { canvas, session, service } = build({
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'DRAFT',
          aiDraft: { totalPoints: '18/20', assignmentFeedback: 'x', rubrics: [] },
        }),
      ],
    });
    await service.postOne(session, { canvasUserId: 1 });
    expect(canvas.postedGrades).toHaveLength(0);
  });

  it('faculty edits win over the AI draft', async () => {
    const { canvas, session, service } = build({
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'APPROVED',
          aiDraft: { totalPoints: '10/20', assignmentFeedback: 'ai says', rubrics: [] },
          facultyEdited: { totalPoints: '15/20', assignmentFeedback: 'teacher says', rubrics: [] },
        }),
      ],
    });
    await service.postOne(session, { canvasUserId: 1 });
    expect(canvas.postedGrades[0]!.args).toMatchObject({
      postedGrade: '15/20',
      comment: '[As Reviewed by John Doe] teacher says',
    });
  });

  it('runs the SyncTotalPoints truth guard at post time (stale holistic total corrected)', async () => {
    const { canvas, session, service } = build({
      rubricSnapshot: [
        { id: '_1', points: 30 },
        { id: '_2', points: 40 },
      ],
      pointsPossible: 70,
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'APPROVED',
          aiDraft: {
            totalPoints: '65/115', // stale holistic string
            assignmentFeedback: 'x',
            rubrics: [
              { criterionId: '_1', ratingId: null, points: 24.5, ratingFeedback: 'a' },
              { criterionId: '_2', ratingId: null, points: 35, ratingFeedback: 'b' },
            ],
          },
        }),
      ],
    });
    await service.postOne(session, { canvasUserId: 1 });
    expect(canvas.postedGrades[0]!.args).toMatchObject({ postedGrade: '59.5/70' });
  });

  it('a Canvas rejection lands the row in ERROR (re-approve to retry), never POSTED', async () => {
    const { store, canvas, doc, session, service } = build({
      grades: [
        makeGrade({
          canvasUserId: 1,
          status: 'APPROVED',
          aiDraft: { totalPoints: '18/20', assignmentFeedback: 'x', rubrics: [] },
        }),
      ],
    });
    canvas.failPostGradeFor.add(1);
    await service.postOne(session, { canvasUserId: 1 });
    expect(doc.grades[0]!.status).toBe('ERROR');
    expect(doc.grades[0]!.postedAt).toBeNull();
    expect(store.saves).toHaveLength(0); // no immediate flush without a post
  });

  it('approved with no draft at all lands in ERROR', async () => {
    const { doc, session, service, canvas } = build({
      grades: [makeGrade({ canvasUserId: 1, status: 'APPROVED' })],
    });
    await service.postOne(session, { canvasUserId: 1 });
    expect(canvas.postedGrades).toHaveLength(0);
    expect(doc.grades[0]!.status).toBe('ERROR');
    expect(doc.grades[0]!.errorMessage).toBe('Approved with no draft to post.');
  });
});

describe('quiz writeback (grouped single PUT)', () => {
  it('gathers ALL approved questions of one attempt into one PUT and flushes', async () => {
    const { store, canvas, doc, session, service, audits } = build({
      canvasQuizId: 42,
      quizGrades: [
        quizEntry({
          canvasUserId: 1,
          quizSubmissionId: 100,
          questionId: 7,
          aiDraft: { score: 4, comment: 'good' },
        }),
        quizEntry({
          canvasUserId: 1,
          quizSubmissionId: 100,
          questionId: 8,
          facultyEdited: { score: 9, comment: 'excellent' },
          aiDraft: { score: 6, comment: 'ai' },
        }),
        // Different attempt — must NOT ride along.
        quizEntry({
          canvasUserId: 2,
          quizSubmissionId: 200,
          questionId: 7,
          aiDraft: { score: 1, comment: 'weak' },
        }),
        // Already posted — the idempotency marker still gates quiz rows.
        quizEntry({
          canvasUserId: 1,
          quizSubmissionId: 100,
          questionId: 9,
          postedAt: '2026-06-10T15:30:00.000Z',
          aiDraft: { score: 2, comment: 'posted already' },
        }),
      ],
    });

    await service.postOne(session, { canvasUserId: 1, quizSubmissionId: 100 });

    expect(canvas.postedQuizGrades).toHaveLength(1);
    const put = canvas.postedQuizGrades[0]!;
    expect(put.quizSubmissionId).toBe(100);
    expect(put.args.attempt).toBe(1);
    expect(Object.keys(put.args.questions).sort()).toEqual(['7', '8']);
    expect(put.args.questions['7']).toEqual({
      score: 4,
      comment: '[As Reviewed by John Doe] good',
    });
    // Faculty edit wins.
    expect(put.args.questions['8']).toEqual({
      score: 9,
      comment: '[As Reviewed by John Doe] excellent',
    });

    const rows = doc.quizGrades.filter((q) => q.quizSubmissionId === 100 && q.questionId !== 9);
    expect(rows.every((q) => q.status === 'POSTED' && q.postedAt != null)).toBe(true);
    expect(store.saves).toHaveLength(1); // immediate flush
    expect(audits.map((a) => a.action)).toEqual(['QuizGradesPosted']);
  });

  it('a failed quiz PUT lands the group in ERROR (idempotent PUT — safe to re-approve)', async () => {
    const { canvas, doc, session, service } = build({
      canvasQuizId: 42,
      quizGrades: [
        quizEntry({
          canvasUserId: 1,
          quizSubmissionId: 100,
          questionId: 7,
          aiDraft: { score: 4, comment: 'good' },
        }),
      ],
    });
    canvas.failQuizPost = true;
    await service.postOne(session, { canvasUserId: 1, quizSubmissionId: 100 });
    expect(doc.quizGrades[0]!.status).toBe('ERROR');
    expect(doc.quizGrades[0]!.postedAt).toBeNull();
  });

  it('nothing approved for the attempt ⇒ no PUT at all', async () => {
    const { canvas, session, service } = build({
      canvasQuizId: 42,
      quizGrades: [
        quizEntry({
          canvasUserId: 1,
          quizSubmissionId: 100,
          questionId: 7,
          status: 'DRAFT',
          aiDraft: { score: 4, comment: 'good' },
        }),
      ],
    });
    await service.postOne(session, { canvasUserId: 1, quizSubmissionId: 100 });
    expect(canvas.postedQuizGrades).toHaveLength(0);
  });
});

describe('double-post guards (bug #4) and the approver prefix (bug #7)', () => {
  const approvedRow = (overrides: Parameters<typeof makeGrade>[0] = { canvasUserId: 1 }) =>
    makeGrade({
      status: 'APPROVED',
      aiDraft: { totalPoints: '18/20', assignmentFeedback: 'Great work.', rubrics: [] },
      ...overrides,
    });

  function withLedger(docOverrides = {}) {
    const base = build(docOverrides);
    const entries = new Map<string, string>();
    const ledger = {
      has: async (runId: string, key: string) => entries.has(`${runId}/${key}`),
      record: async (e: { runId: string; key: string; postedAt: string }) => {
        entries.set(`${e.runId}/${e.key}`, e.postedAt);
      },
    };
    const service = new WritebackService({ canvas: base.canvas, ledger, warn: () => {} });
    return { ...base, service, entries };
  }

  it('prefixes with the APPROVER, not the run starter', async () => {
    const { canvas, session, service } = build({
      grades: [
        approvedRow({
          canvasUserId: 1,
          approvedBy: { canvasUserId: 44, name: 'Jane Approver', approvedAt: '2026-06-10T15:40:00.000Z', channel: 'browser' },
        }),
      ],
    });
    await service.postOne(session, { canvasUserId: 1 });
    expect((canvas.postedGrades[0]!.args as { comment: string }).comment).toBe(
      '[As Reviewed by Jane Approver] Great work.',
    );
  });

  it('a Canvas rejection is marked errorKind "post" with the re-approve message', async () => {
    const { canvas, doc, session, service } = build({ grades: [approvedRow()] });
    canvas.failPostGradeFor.add(1);
    await service.postOne(session, { canvasUserId: 1 });
    expect(doc.grades[0]!.status).toBe('ERROR');
    expect(doc.grades[0]!.errorKind).toBe('post');
    expect(doc.grades[0]!.errorMessage).toBe(POST_FAILED_MESSAGE);
  });

  it('two concurrent posts of the same row call Canvas once (in-flight claim)', async () => {
    const { canvas, session, service } = build({ grades: [approvedRow()] });
    await Promise.all([
      service.postOne(session, { canvasUserId: 1 }),
      service.postOne(session, { canvasUserId: 1 }),
    ]);
    expect(canvas.postedGrades).toHaveLength(1);
  });

  it('the local ledger records a post, and a ledger hit marks POSTED without calling Canvas', async () => {
    const first = withLedger({ grades: [approvedRow()] });
    await first.service.postOne(first.session, { canvasUserId: 1 });
    expect(first.entries.has('run1/u1')).toBe(true);

    // Crash between the post and the checkpoint: the row is APPROVED again
    // with no PostedAt, but the ledger remembers.
    const second = withLedger({ grades: [approvedRow()] });
    second.entries.set('run1/u1', '2026-06-10T15:45:00.000Z');
    await second.service.postOne(second.session, { canvasUserId: 1 });
    expect(second.canvas.postedGrades).toHaveLength(0);
    expect(second.doc.grades[0]!.status).toBe('POSTED');
  });

  it('the identical prefixed comment already on the submission ⇒ POSTED, no second post', async () => {
    const { canvas, doc, session, service } = build({ grades: [approvedRow()] });
    canvas.submissions = [
      {
        ...textSubmissionFor(1),
        submission_comments: [
          { id: 5, author_id: 9, comment: '[As Reviewed by John Doe] Great work.', created_at: '2026-06-10T15:20:00Z' },
        ],
      },
    ];
    await service.postOne(session, { canvasUserId: 1 });
    expect(canvas.postedGrades).toHaveLength(0);
    expect(doc.grades[0]!.status).toBe('POSTED');
    expect(doc.grades[0]!.postedAt).toBe('2026-06-10T15:20:00Z');
  });

  it('an identical comment from BEFORE this run does not block the post', async () => {
    const { canvas, session, service } = build({ grades: [approvedRow()] });
    canvas.submissions = [
      {
        ...textSubmissionFor(1),
        submission_comments: [
          { id: 5, author_id: 9, comment: '[As Reviewed by John Doe] Great work.', created_at: '2026-06-01T10:00:00Z' },
        ],
      },
    ];
    await service.postOne(session, { canvasUserId: 1 });
    expect(canvas.postedGrades).toHaveLength(1);
  });
});
