// /alignment service endpoints: report/get heuristic fallback, run
// (heuristic = live snapshot, ai = persisted + audited), the outcome
// management wrappers (course-list / library browse / link / unlink /
// create) with their audit events and the AI-Profile outcome-ref sync.
// Canvas + stores are faked at the client-factory seam; audits are captured
// via the injected auditFn — route-level tests over real HTTP.

import { describe, expect, it } from 'vitest';
import express from 'express';
import { CanvasError, type CanvasAssignment, type CanvasOutcome } from '@aigrader/canvas';
import {
  AlignmentHistoryDocumentSchema,
  CourseSettingsProfileSchema,
  type AlignmentHistoryDocument,
  type AlignmentReport,
  type AuditFields,
  type CourseSettingsProfile,
} from '@aigrader/shared';
import {
  createAlignmentRouter,
  historySummaries,
  type AlignmentRouteClients,
} from '../src/alignment/routes.js';
import type { AssignmentAlignment } from '../src/llm/alignment-schemas.js';
import { postJson, withServer } from './helpers.js';


function baseBody(extra: Record<string, unknown> = {}) {
  return { apiDomain: 'school.instructure.com', courseId: 42, ...extra };
}

function assignment(partial: Partial<CanvasAssignment> & { id: number }): CanvasAssignment {
  return {
    name: `Assignment ${partial.id}`,
    description: null,
    submission_types: ['online_upload'],
    grading_type: 'points',
    published: true,
    rubric: null,
    ...partial,
  } as CanvasAssignment;
}

const REVIEW_OK: AssignmentAlignment = {
  alignmentScore: 90,
  summary: 'fine',
  findings: [
    {
      severity: 'high',
      pairing: 'rubric_outcome',
      title: 'T',
      detail: 'D',
      suggestion: 'S',
    },
  ],
};

/** In-memory fakes satisfying the routes' structural ports. */
function makeFakes(opts: {
  assignments?: CanvasAssignment[];
  courseOutcomes?: CanvasOutcome[];
  savedDoc?: AlignmentHistoryDocument | null;
  unlinkError?: Error;
} = {}) {
  let courseOutcomes: CanvasOutcome[] = opts.courseOutcomes ?? [
    { id: 1, title: 'Linked One', description: '<p>One&nbsp;desc</p>' },
  ];
  const library = new Map<number, { subgroups: { id: number; title: string }[]; outcomes: CanvasOutcome[] }>([
    [100, { subgroups: [{ id: 101, title: 'Writing' }], outcomes: [] }],
    [101, { subgroups: [], outcomes: [{ id: 9, title: 'Lib Outcome', description: '<b>lib</b>' }] }],
  ]);

  const calls: string[] = [];
  const savedProfiles: CourseSettingsProfile[] = [];
  const appended: AlignmentReport[] = [];
  let doc: AlignmentHistoryDocument | null = opts.savedDoc ?? null;

  const clients: AlignmentRouteClients = {
    canvas: {
      getGradableItems: async () => opts.assignments ?? [assignment({ id: 1 })],
      getCourseOutcomes: async () => courseOutcomes,
      getCourseInfo: async () => {
        calls.push('getCourseInfo');
        return { id: 42, name: 'C', account_id: 3, root_account_id: 2 };
      },
      getAccountRootOutcomeGroup: async (accountId) => {
        calls.push(`root:${accountId}`);
        return { id: 100, title: 'Institution Library' };
      },
      getAccountOutcomeSubgroups: async (accountId, groupId) => {
        calls.push(`subgroups:${accountId}:${groupId}`);
        return library.get(groupId)?.subgroups ?? [];
      },
      getAccountOutcomeGroupOutcomes: async (accountId, groupId) => {
        calls.push(`outcomes:${accountId}:${groupId}`);
        return library.get(groupId)?.outcomes ?? [];
      },
      linkOutcomeToCourse: async (_courseId, outcomeId) => {
        calls.push(`link:${outcomeId}`);
        courseOutcomes = [
          ...courseOutcomes,
          { id: outcomeId, title: `Outcome ${outcomeId}`, description: '' },
        ];
      },
      unlinkOutcomeFromCourse: async (_courseId, outcomeId) => {
        if (opts.unlinkError) throw opts.unlinkError;
        calls.push(`unlink:${outcomeId}`);
        courseOutcomes = courseOutcomes.filter((o) => o.id !== outcomeId);
      },
      createCourseOutcome: async (_courseId, title, description) => {
        calls.push(`create:${title}`);
        const created = { id: 77, title, description };
        courseOutcomes = [...courseOutcomes, created];
        return created;
      },
    },
    profiles: {
      get: async () =>
        structuredClone(savedProfiles[savedProfiles.length - 1] ?? CourseSettingsProfileSchema.parse({})),
      save: async (_courseId, profile) => {
        savedProfiles.push(structuredClone(profile));
      },
    },
    alignment: {
      get: async () => doc,
      appendReport: async (courseId, report) => {
        appended.push(report);
        if (!doc) doc = AlignmentHistoryDocumentSchema.parse({ canvasCourseId: courseId });
        if (doc.latest !== null) doc.history.unshift(doc.latest);
        doc.latest = report;
        return doc;
      },
    },
  };

  const audits: Array<{ action: string; fields: AuditFields }> = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/alignment',
    createAlignmentRouter({
      clients: async () => clients,
      review: async () => REVIEW_OK,
      auditFn: (action, fields = {}) => {
        audits.push({ action, fields });
      },
    }),
  );

  return { app, calls, savedProfiles, appended, audits };
}

// --------------------------------------------------------------- reports ---

describe('POST /alignment/report/get', () => {
  it('falls back to a live (non-persisted) heuristic when nothing is saved', async () => {
    const { app, appended } = makeFakes({
      assignments: [assignment({ id: 1, rubric: [{ id: '_1', description: 'C', long_description: null, points: 5, learning_outcome_id: 1, ratings: null }] })],
    });
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/report/get', baseBody());
      expect(res.status).toBe(200);
      const body = res.body as { latest: AlignmentReport; history: unknown[] };
      expect(body.latest.method).toBe('heuristic');
      expect(body.latest.alignmentScore).toBe(100); // outcomes ✓ all-rubrics ✓ link ✓
      expect(body.history).toEqual([]);
    });
    expect(appended).toHaveLength(0);
  });

  it('returns the saved latest + history stubs when an audit exists', async () => {
    const report = (score: number, scannedAt: string): AlignmentReport =>
      ({
        method: 'ai',
        scannedAt,
        outcomes: { found: 1, aligned: 0 },
        rubrics: { found: 0, aligned: 0 },
        assignmentsScanned: 1,
        reviewed: 1,
        assignments: [],
        scanErrors: [],
        alignmentScore: score,
        issues: [
          { severity: 'high', assignment: 'A', pairing: 'rubric_outcome', title: 't', detail: 'd', suggestion: 's' },
        ],
      }) as AlignmentReport;
    const savedDoc = AlignmentHistoryDocumentSchema.parse({
      canvasCourseId: 42,
      latest: report(90, '2026-07-02T00:00:00.000Z'),
      history: [report(60, '2026-07-01T00:00:00.000Z')],
    });

    const { app } = makeFakes({ savedDoc });
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/report/get', baseBody());
      const body = res.body as { latest: AlignmentReport; history: Array<Record<string, unknown>> };
      expect(body.latest.alignmentScore).toBe(90);
      expect(body.history).toEqual([
        {
          scannedAt: '2026-07-01T00:00:00.000Z',
          method: 'ai',
          alignmentScore: 60,
          issueCount: 1,
          highSeverityCount: 1,
        },
      ]);
    });
  });

  it('rejects bodies without a courseId', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/report/get', { apiDomain: 'school.instructure.com' });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_request');
    });
  });
});

describe('POST /alignment/run', () => {
  it('heuristic: live snapshot — no persistence, no audit', async () => {
    const { app, appended, audits } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/run', baseBody({ method: 'heuristic' }));
      expect(res.status).toBe(200);
      const body = res.body as { latest: AlignmentReport; history: null };
      expect(body.latest.method).toBe('heuristic');
      expect(body.history).toBeNull();
    });
    expect(appended).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('ai: persists via the store, emits AlignmentReviewed, returns fresh history', async () => {
    const { app, appended, audits } = makeFakes();
    await withServer(app, async (base) => {
      const first = await postJson(base, '/alignment/run', baseBody({ method: 'ai' }));
      expect(first.status).toBe(200);
      expect((first.body as { latest: AlignmentReport }).latest.method).toBe('ai');
      expect((first.body as { history: unknown[] }).history).toEqual([]);

      const second = await postJson(base, '/alignment/run', baseBody({ method: 'ai' }));
      const history = (second.body as { history: Array<{ alignmentScore: number }> }).history;
      expect(history).toHaveLength(1); // the first run demoted into history
    });
    expect(appended).toHaveLength(2);
    expect(audits.map((a) => a.action)).toEqual(['AlignmentReviewed', 'AlignmentReviewed']);
    expect(audits[0]!.fields).toMatchObject({
      canvasCourseId: 42,
      apiDomain: 'school.instructure.com',
      method: 'ai',
      alignmentScore: 90,
      issueCount: 1,
    });
  });

  it('rejects unknown methods', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/run', baseBody({ method: 'vibes' }));
      expect(res.status).toBe(400);
    });
  });
});

// -------------------------------------------------------------- outcomes ---

describe('outcome management endpoints', () => {
  it('course-list returns stripped-HTML rows AND syncs refs into the profile', async () => {
    const { app, savedProfiles } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/outcomes/course-list', baseBody());
      expect(res.status).toBe(200);
      expect((res.body as { outcomes: unknown[] }).outcomes).toEqual([
        { id: 1, title: 'Linked One', description: 'One desc' },
      ]);
    });
    expect(savedProfiles).toHaveLength(1);
    expect(savedProfiles[0]!.canvasOutcomes).toEqual([
      { id: '1', title: 'Linked One', description: 'One desc' },
    ]);
  });

  it('course-list does NOT rewrite the profile when the outcomes are unchanged (bug #14)', async () => {
    const { app, savedProfiles } = makeFakes();
    await withServer(app, async (base) => {
      await postJson(base, '/alignment/outcomes/course-list', baseBody());
      await postJson(base, '/alignment/outcomes/course-list', baseBody());
      await postJson(base, '/alignment/outcomes/course-list', baseBody());
    });
    expect(savedProfiles).toHaveLength(1);
  });

  it('library-root resolves the ROOT account and returns the entry group', async () => {
    const { app, calls } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/outcomes/library-root', baseBody());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        accountId: 2, // root_account_id wins over account_id
        group: { id: 100, title: 'Institution Library' },
      });
    });
    expect(calls).toEqual(['getCourseInfo', 'root:2']);
  });

  it('library-subgroups / library-outcomes skip account resolution when accountId is given', async () => {
    const { app, calls } = makeFakes();
    await withServer(app, async (base) => {
      const sub = await postJson(
        base,
        '/alignment/outcomes/library-subgroups',
        baseBody({ groupId: 100, accountId: 2 }),
      );
      expect(sub.body).toEqual({ accountId: 2, subgroups: [{ id: 101, title: 'Writing' }] });

      const out = await postJson(
        base,
        '/alignment/outcomes/library-outcomes',
        baseBody({ groupId: 101, accountId: 2 }),
      );
      expect(out.body).toEqual({
        accountId: 2,
        outcomes: [{ id: 9, title: 'Lib Outcome', description: 'lib' }],
      });
    });
    expect(calls).toEqual(['subgroups:2:100', 'outcomes:2:101']);
  });

  it('link audits OutcomeLinked and returns the refreshed, re-synced list', async () => {
    const { app, audits, savedProfiles } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/outcomes/link', baseBody({ outcomeId: 9 }));
      expect(res.status).toBe(200);
      const outcomes = (res.body as { outcomes: Array<{ id: number }> }).outcomes;
      expect(outcomes.map((o) => o.id)).toEqual([1, 9]);
    });
    expect(audits).toEqual([
      {
        action: 'OutcomeLinked',
        fields: { canvasCourseId: 42, outcomeId: 9, apiDomain: 'school.instructure.com' },
      },
    ]);
    expect(savedProfiles[0]!.canvasOutcomes.map((o) => o.id)).toEqual(['1', '9']);
  });

  it('unlink audits OutcomeUnlinked; refusals surface as 409 with the message', async () => {
    const ok = makeFakes();
    await withServer(ok.app, async (base) => {
      const res = await postJson(base, '/alignment/outcomes/unlink', baseBody({ outcomeId: 1 }));
      expect(res.status).toBe(200);
      expect((res.body as { outcomes: unknown[] }).outcomes).toEqual([]);
    });
    expect(ok.audits.map((a) => a.action)).toEqual(['OutcomeUnlinked']);

    // Plain client error ("not linked") → 409 outcome_conflict.
    const notLinked = makeFakes({ unlinkError: new Error('That outcome is not linked to this course.') });
    await withServer(notLinked.app, async (base) => {
      const res = await postJson(base, '/alignment/outcomes/unlink', baseBody({ outcomeId: 5 }));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'outcome_conflict',
        message: 'That outcome is not linked to this course.',
      });
    });
    expect(notLinked.audits).toHaveLength(0);

    // Canvas 4xx refusal → 409 with Canvas's own message.
    const inUse = makeFakes({
      unlinkError: new CanvasError(
        400,
        'https://x/api/v1/...',
        JSON.stringify({ message: 'Outcome cannot be deleted because it is aligned to content' }),
      ),
    });
    await withServer(inUse.app, async (base) => {
      const res = await postJson(base, '/alignment/outcomes/unlink', baseBody({ outcomeId: 1 }));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'canvas_rejected',
        message: 'Outcome cannot be deleted because it is aligned to content',
      });
    });
  });

  it('create audits OutcomeCreated and returns the created row + refreshed list', async () => {
    const { app, audits } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(
        base,
        '/alignment/outcomes/create',
        baseBody({ title: '  New Outcome  ', description: 'Desc' }),
      );
      expect(res.status).toBe(200);
      const body = res.body as { outcome: { id: number; title: string }; outcomes: unknown[] };
      expect(body.outcome).toEqual({ id: 77, title: 'New Outcome', description: 'Desc' });
      expect(body.outcomes).toHaveLength(2);
    });
    expect(audits).toEqual([
      {
        action: 'OutcomeCreated',
        fields: { canvasCourseId: 42, outcomeId: 77, apiDomain: 'school.instructure.com' },
      },
    ]);
  });

  it('create requires a title', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/outcomes/create', baseBody({ description: 'x' }));
      expect(res.status).toBe(400);
    });
  });
});

// --------------------------------------------------------- actor threading ---

describe('actor threading into audits', () => {
  const ACTOR = { actor: { canvasUserId: '553' } };

  it('AlignmentReviewed carries actorCanvasUserId when the body names an actor', async () => {
    const { app, audits } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/alignment/run', baseBody({ method: 'ai', ...ACTOR }));
      expect(res.status).toBe(200);
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.fields.actorCanvasUserId).toBe('553');
  });

  it('outcome link/unlink/create audits carry actorCanvasUserId', async () => {
    const { app, audits } = makeFakes();
    await withServer(app, async (base) => {
      await postJson(base, '/alignment/outcomes/link', baseBody({ outcomeId: 9, ...ACTOR }));
      await postJson(base, '/alignment/outcomes/unlink', baseBody({ outcomeId: 9, ...ACTOR }));
      await postJson(
        base,
        '/alignment/outcomes/create',
        baseBody({ title: 'New', description: '', ...ACTOR }),
      );
    });
    expect(audits.map((a) => a.action)).toEqual([
      'OutcomeLinked',
      'OutcomeUnlinked',
      'OutcomeCreated',
    ]);
    for (const a of audits) expect(a.fields.actorCanvasUserId).toBe('553');
  });

  it('audits omit actorCanvasUserId when no actor rides along (existing behavior)', async () => {
    const { app, audits } = makeFakes();
    await withServer(app, async (base) => {
      await postJson(base, '/alignment/outcomes/link', baseBody({ outcomeId: 9 }));
    });
    expect(audits[0]!.fields.actorCanvasUserId).toBeUndefined();
  });
});

// ------------------------------------------------------- history mapping ---

describe('historySummaries', () => {
  it('maps full history reports to stubs, appends the archive, newest first', () => {
    const doc = AlignmentHistoryDocumentSchema.parse({
      canvasCourseId: 1,
      history: [
        {
          method: 'ai',
          scannedAt: '2026-07-10T00:00:00.000Z',
          alignmentScore: 70,
          issues: [
            { severity: 'high', assignment: 'A', pairing: 'rubric_outcome', title: 't', detail: 'd', suggestion: 's' },
            { severity: 'low', assignment: 'A', pairing: 'rubric_instructions', title: 't', detail: 'd', suggestion: 's' },
          ],
        },
      ],
      archive: [
        {
          scannedAt: '2026-07-20T00:00:00.000Z',
          method: 'ai',
          alignmentScore: 50,
          issueCount: 9,
          highSeverityCount: 3,
        },
      ],
    });

    expect(historySummaries(doc)).toEqual([
      {
        scannedAt: '2026-07-20T00:00:00.000Z',
        method: 'ai',
        alignmentScore: 50,
        issueCount: 9,
        highSeverityCount: 3,
      },
      {
        scannedAt: '2026-07-10T00:00:00.000Z',
        method: 'ai',
        alignmentScore: 70,
        issueCount: 2,
        highSeverityCount: 1,
      },
    ]);
  });
});
