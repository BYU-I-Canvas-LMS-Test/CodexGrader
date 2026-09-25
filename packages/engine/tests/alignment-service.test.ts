// AlignmentService: the heuristic tier's scoring rules are pinned here (no C#
// test existed — cases derive from AlignmentService.cs RunHeuristicAsync), the
// AI tier's 12-assignment cap and concurrency-4 fan-out run against a fake
// review fn (no model call), aggregation/rounding match the C# math, and the
// service→AlignmentStore wiring is verified against the REAL AlignmentStore
// over an in-memory document store (history demotion is the store's own
// tested behavior).

import { describe, expect, it } from 'vitest';
import type { CanvasAssignment, CanvasOutcome, CourseDocumentStore } from '@aigrader/canvas';
import { AlignmentStore } from '@aigrader/canvas';
import type { AlignmentReport } from '@aigrader/shared';
import {
  AlignmentService,
  MAX_ASSIGNMENTS_PER_REVIEW,
  REVIEW_CONCURRENCY,
  roundHalfToEven,
  type AlignmentReviewFn,
} from '../src/alignment/service.js';
import type { AssignmentAlignment } from '../src/llm/alignment-schemas.js';
import type { AlignmentReviewInput } from '../src/alignment/review-agent.js';

// ------------------------------------------------------------- fixtures ----

function assignment(
  partial: Partial<CanvasAssignment> & { id: number },
): CanvasAssignment {
  return {
    name: `Assignment ${partial.id}`,
    description: null,
    submission_types: ['online_upload'],
    points_possible: 10,
    due_at: null,
    needs_grading_count: 0,
    has_submitted_submissions: false,
    published: true,
    grading_type: 'points',
    quiz_id: null,
    discussion_topic: null,
    rubric: null,
    rubric_settings: null,
    ...partial,
  } as CanvasAssignment;
}

function criterion(id: string, learningOutcomeId: number | string | null = null) {
  return {
    id,
    description: `Criterion ${id}`,
    long_description: null,
    points: 5,
    learning_outcome_id: learningOutcomeId,
    ratings: null,
  };
}

function outcome(id: number, title = `Outcome ${id}`): CanvasOutcome {
  return { id, title, description: `<p>${title} description</p>` };
}

function review(score: number, findings: AssignmentAlignment['findings'] = []): AssignmentAlignment {
  return { alignmentScore: score, summary: `scored ${score}`, findings };
}

function makeService(opts: {
  outcomes?: CanvasOutcome[];
  assignments?: CanvasAssignment[];
  review?: AlignmentReviewFn;
  maxAssignments?: number;
  concurrency?: number;
}) {
  const appended: AlignmentReport[] = [];
  const service = new AlignmentService({
    canvas: {
      getGradableItems: async () => opts.assignments ?? [],
      getCourseOutcomes: async () => opts.outcomes ?? [],
    },
    store: {
      appendReport: async (_courseId, report) => {
        appended.push(report);
        return null;
      },
    },
    review: opts.review ?? (async () => review(80)),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    ...(opts.maxAssignments !== undefined ? { maxAssignments: opts.maxAssignments } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    warn: () => {},
  });
  return { service, appended };
}

// --------------------------------------------------------- heuristic tier --

describe('AlignmentService.runHeuristic (pinned scoring rules)', () => {
  it('scores 0 for an empty course and marks nothing aligned', async () => {
    const { service, appended } = makeService({});
    const report = await service.runHeuristic(42);

    expect(report.method).toBe('heuristic');
    expect(report.alignmentScore).toBe(0);
    expect(report.outcomes).toMatchObject({ found: 0, aligned: 0 });
    expect(report.rubrics).toMatchObject({ found: 0, aligned: 0 });
    expect(report.assignmentsScanned).toBe(0);
    expect(report.reviewed).toBe(0);
    expect(appended).toHaveLength(0); // heuristic is NEVER persisted
  });

  it('scores 33 when only outcomes exist (C# integer division: 1*100/3)', async () => {
    const { service } = makeService({
      outcomes: [outcome(1)],
      assignments: [assignment({ id: 10 })], // no rubric
    });
    const report = await service.runHeuristic(42);
    expect(report.alignmentScore).toBe(33);
    expect(report.assignments.map((a) => a.status)).toEqual(['skipped']);
  });

  it('scores 66 when outcomes exist and EVERY assignment has a rubric (2*100/3)', async () => {
    const { service } = makeService({
      outcomes: [outcome(1)],
      assignments: [
        assignment({ id: 10, rubric: [criterion('_1')] }),
        assignment({ id: 11, rubric: [criterion('_2')] }),
      ],
    });
    const report = await service.runHeuristic(42);
    expect(report.alignmentScore).toBe(66);
    expect(report.rubrics).toMatchObject({ found: 2, aligned: 0 });
  });

  it('the all-rubrics check requires EVERY assignment covered, not just some', async () => {
    const { service } = makeService({
      outcomes: [outcome(1)],
      assignments: [
        assignment({ id: 10, rubric: [criterion('_1', 1)] }), // outcome-linked
        assignment({ id: 11 }), // rubric-less — fails the "all have rubrics" check
      ],
    });
    const report = await service.runHeuristic(42);
    // checks: outcomes ✓, all-rubrics ✗, any-link ✓ → 2*100/3 = 66
    expect(report.alignmentScore).toBe(66);
  });

  it('scores 100 with outcomes + full rubric coverage + at least one link', async () => {
    const { service } = makeService({
      outcomes: [outcome(1), outcome(2)],
      assignments: [
        assignment({ id: 10, rubric: [criterion('_1', 1)] }),
        assignment({ id: 11, rubric: [criterion('_2')] }),
      ],
    });
    const report = await service.runHeuristic(42);
    expect(report.alignmentScore).toBe(100);
    // outcome 1 is referenced by a criterion; outcome 2 is not.
    expect(report.outcomes).toMatchObject({ found: 2, aligned: 1 });
    // one of the two rubric-carrying assignments has a linked criterion.
    expect(report.rubrics).toMatchObject({ found: 2, aligned: 1 });
  });

  it('compares outcome links in string space (Canvas mixes number/string ids)', async () => {
    const { service } = makeService({
      outcomes: [outcome(7)],
      assignments: [assignment({ id: 10, rubric: [criterion('_1', '7')] })],
    });
    const report = await service.runHeuristic(42);
    expect(report.outcomes).toMatchObject({ found: 1, aligned: 1 });
  });
});

// -------------------------------------------------------------- AI tier ----

describe('AlignmentService.runAiReview', () => {
  it('caps the review set at 12 but counts rubrics/outcomes over the WHOLE course', async () => {
    // 13 assignments; ONLY the 13th (beyond the cap) carries the linked rubric.
    const assignments = Array.from({ length: 12 }, (_, i) => assignment({ id: i + 1 }));
    assignments.push(assignment({ id: 13, rubric: [criterion('_x', 5)] }));

    const reviewed: string[] = [];
    const { service, appended } = makeService({
      outcomes: [outcome(5)],
      assignments,
      review: async (input) => {
        reviewed.push(input.assignmentName);
        return review(90);
      },
    });

    const report = await service.runAiReview(42);

    expect(MAX_ASSIGNMENTS_PER_REVIEW).toBe(12);
    expect(reviewed).toHaveLength(12);
    expect(report.assignmentsScanned).toBe(12);
    expect(report.reviewed).toBe(12);
    expect(reviewed).not.toContain('Assignment 13');
    // Course-wide counters still see assignment 13's rubric + link.
    expect(report.rubrics).toMatchObject({ found: 1, aligned: 1 });
    expect(report.outcomes).toMatchObject({ found: 1, aligned: 1 });
    expect(appended).toHaveLength(1); // AI reviews persist
  });

  it('fans out at most 4 reviews at a time (deterministic gate)', async () => {
    const assignments = Array.from({ length: 9 }, (_, i) => assignment({ id: i + 1 }));
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;

    const { service } = makeService({
      assignments,
      review: (input: AlignmentReviewInput) => {
        void input;
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<AssignmentAlignment>((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve(review(75));
          });
        });
      },
    });

    const running = service.runAiReview(42);

    // Let the queue admit its first wave, then verify the in-flight ceiling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(REVIEW_CONCURRENCY).toBe(4);
    expect(releases).toHaveLength(4);

    // Drain: releasing one admits the next, never exceeding 4 in flight.
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const report = await running;
    expect(maxActive).toBe(4);
    expect(report.reviewed).toBe(9);
  });

  it('records failed reviews as scanErrors + status "error" and keeps going', async () => {
    const { service } = makeService({
      assignments: [assignment({ id: 1 }), assignment({ id: 2 }), assignment({ id: 3 })],
      review: async (input) => {
        if (input.assignmentName === 'Assignment 2') throw new Error('LLM exploded');
        return review(80, [
          {
            severity: 'high',
            pairing: 'rubric_outcome',
            title: 'T',
            detail: 'D',
            suggestion: 'S',
          },
        ]);
      },
    });

    const report = await service.runAiReview(42);

    expect(report.reviewed).toBe(2);
    expect(report.scanErrors).toEqual([{ assignment: 'Assignment 2', message: 'LLM exploded' }]);
    expect(report.assignments.map((a) => [a.assignmentName, a.status])).toEqual([
      ['Assignment 1', 'reviewed'],
      ['Assignment 2', 'error'],
      ['Assignment 3', 'reviewed'],
    ]);
    // Findings carry the assignment name; the errored row contributed none.
    expect(report.issues).toHaveLength(2);
    expect(report.issues.map((i) => i.assignment)).toEqual(['Assignment 1', 'Assignment 3']);
    // Overall = mean of the two successful scores.
    expect(report.alignmentScore).toBe(80);
  });

  it('feeds the reviewer rubric/outcome context (links resolved to titles)', async () => {
    const inputs: AlignmentReviewInput[] = [];
    const { service } = makeService({
      outcomes: [outcome(5, 'Think critically')],
      assignments: [
        assignment({
          id: 1,
          description: '<p>Write&nbsp;well.</p>',
          rubric: [criterion('_a', 5), criterion('_b')],
        }),
      ],
      review: async (input) => {
        inputs.push(input);
        return review(70);
      },
    });

    await service.runAiReview(42);

    const input = inputs[0]!;
    expect(input.instructionsText).toBe('Write well.'); // HTML stripped
    expect(input.outcomes).toEqual([
      { title: 'Think critically', description: 'Think critically description' },
    ]);
    expect(input.rubric[0]).toMatchObject({
      outcomeLinked: true,
      linkedOutcomeTitle: 'Think critically',
    });
    expect(input.rubric[1]).toMatchObject({ outcomeLinked: false, linkedOutcomeTitle: null });
  });

  it('rounds per-assignment and overall scores half-to-even (C# Math.Round)', async () => {
    const scores = new Map([
      ['Assignment 1', 82.5], // → 82 (even)
      ['Assignment 2', 81.5], // → 82
    ]);
    const { service } = makeService({
      assignments: [assignment({ id: 1 }), assignment({ id: 2 })],
      review: async (input) => review(scores.get(input.assignmentName)!),
    });

    const report = await service.runAiReview(42);
    expect(report.assignments.map((a) => a.alignmentScore)).toEqual([82, 82]);
    expect(report.alignmentScore).toBe(82);
  });

  it('scores 0 overall when every review failed', async () => {
    const { service } = makeService({
      assignments: [assignment({ id: 1 })],
      review: async () => {
        throw new Error('down');
      },
    });
    const report = await service.runAiReview(42);
    expect(report.alignmentScore).toBe(0);
    expect(report.reviewed).toBe(0);
  });
});

describe('roundHalfToEven', () => {
  it('matches C# MidpointRounding.ToEven', () => {
    expect(roundHalfToEven(0.5)).toBe(0);
    expect(roundHalfToEven(1.5)).toBe(2);
    expect(roundHalfToEven(2.5)).toBe(2);
    expect(roundHalfToEven(81.5)).toBe(82);
    expect(roundHalfToEven(82.5)).toBe(82);
    expect(roundHalfToEven(2.4)).toBe(2);
    expect(roundHalfToEven(2.6)).toBe(3);
    expect(roundHalfToEven(88)).toBe(88);
  });
});

// -------------------------------------------------- store wiring (real) ----

describe('service → AlignmentStore wiring', () => {
  it('appends through the real store: latest demotes into history across runs', async () => {
    // In-memory CourseDocumentStore fake (get/put/exclusive are all
    // AlignmentStore uses).
    const docs = new Map<string, unknown>();
    const docStore = {
      exclusive: async <T>(_courseId: number, _name: string, fn: () => Promise<T>) => fn(),
      get: async (courseId: number, name: string, schema: { parse: (v: unknown) => unknown }) => {
        const raw = docs.get(`${courseId}/${name}`);
        return raw === undefined ? null : schema.parse(raw);
      },
      put: async (courseId: number, name: string, doc: unknown) => {
        docs.set(`${courseId}/${name}`, JSON.parse(JSON.stringify(doc)));
      },
    } as unknown as CourseDocumentStore;
    const store = new AlignmentStore(docStore);

    let call = 0;
    const service = new AlignmentService({
      canvas: {
        getGradableItems: async () => [assignment({ id: 1 })],
        getCourseOutcomes: async () => [],
      },
      store,
      review: async () => review(call === 0 ? 60 : 90),
      now: () => new Date(`2026-07-2${(call += 1)}T00:00:00.000Z`),
      warn: () => {},
    });

    const first = await service.runAiReview(7);
    const second = await service.runAiReview(7);
    expect(first.alignmentScore).toBe(60);
    expect(second.alignmentScore).toBe(90);

    const doc = await store.get(7);
    expect(doc).not.toBeNull();
    expect(doc!.latest!.alignmentScore).toBe(90);
    expect(doc!.history.map((r) => r.alignmentScore)).toEqual([60]);
    expect(doc!.canvasCourseId).toBe(7);
  });
});
