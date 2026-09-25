// /course/rubric service endpoints: get (full AssignmentRubric shape incl.
// the shared/sharedUnknown warning flags), update (criteria pass through
// EXACTLY — raw-string ids, '' marking new rows — per the id round-trip rule
// pinned in @aigrader/canvas), Canvas refusals → 409 with Canvas's message, and
// the RubricUpdated audit (IDs/counts only + actorCanvasUserId). Canvas is
// faked at the client-factory seam; route-level tests over real HTTP.

import { describe, expect, it } from 'vitest';
import express from 'express';
import {
  CanvasError,
  type AssignmentRubric,
  type RubricCriterionInput,
} from '@aigrader/canvas';
import type { AuditFields } from '@aigrader/shared';
import { createRubricRouter, type RubricRouteClients } from '../src/rubric-routes.js';
import { postJson, withServer } from './helpers.js';


function baseBody(extra: Record<string, unknown> = {}) {
  return { apiDomain: 'school.instructure.com', courseId: 42, ...extra };
}

/** A rubric as getAssignmentRubric composes it — mixed raw-string id forms. */
const RUBRIC: AssignmentRubric = {
  hasRubric: true,
  rubricId: 88,
  title: 'Essay Rubric',
  criteria: [
    {
      id: '_4692',
      description: 'Thesis',
      long_description: '<p>Clear thesis</p>',
      points: 5,
      learning_outcome_id: 7,
      ratings: [
        { id: 'blank', description: 'Full Marks', long_description: null, points: 5 },
        { id: 'blank_2', description: 'No Marks', long_description: null, points: 0 },
      ],
    },
    {
      id: '170',
      description: 'Evidence',
      long_description: null,
      points: 10,
      learning_outcome_id: null,
      ratings: [{ id: '171', description: 'Good', long_description: null, points: 10 }],
    },
  ],
  rubricAssociationId: 12,
  otherAssignmentCount: 2,
  shared: true,
  sharedUnknown: false,
};

const NO_RUBRIC: AssignmentRubric = {
  hasRubric: false,
  rubricId: 0,
  title: '',
  criteria: [],
  rubricAssociationId: null,
  otherAssignmentCount: 0,
  shared: false,
  sharedUnknown: false,
};

function makeFakes(opts: { rubric?: AssignmentRubric; updateError?: Error } = {}) {
  const getCalls: Array<{ courseId: number; assignmentId: number }> = [];
  const updateCalls: Array<{
    courseId: number;
    rubricId: number;
    args: {
      title: string;
      criteria: readonly RubricCriterionInput[];
      rubricAssociationId?: number | string | null;
    };
  }> = [];

  const clients: RubricRouteClients = {
    canvas: {
      getAssignmentRubric: async (courseId, assignmentId) => {
        getCalls.push({ courseId, assignmentId });
        return opts.rubric ?? RUBRIC;
      },
      updateRubric: async (courseId, rubricId, args) => {
        if (opts.updateError) throw opts.updateError;
        updateCalls.push({ courseId, rubricId, args });
      },
    },
  };

  const audits: Array<{ action: string; fields: AuditFields }> = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/course/rubric',
    createRubricRouter({
      clients: async () => clients,
      auditFn: (action, fields = {}) => {
        audits.push({ action, fields });
      },
    }),
  );

  return { app, getCalls, updateCalls, audits };
}

// ------------------------------------------------------------------- /get ---

describe('POST /course/rubric/get', () => {
  it('returns the full rubric shape including the shared flags', async () => {
    const { app, getCalls } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/rubric/get', baseBody({ assignmentId: 7 }));
      expect(res.status).toBe(200);
      const rubric = (res.body as { rubric: AssignmentRubric }).rubric;
      expect(rubric).toEqual(RUBRIC); // criteria ids ride raw, untouched
      expect(rubric.shared).toBe(true);
      expect(rubric.otherAssignmentCount).toBe(2);
      expect(rubric.sharedUnknown).toBe(false);
    });
    expect(getCalls).toEqual([{ courseId: 42, assignmentId: 7 }]);
  });

  it('passes the no-rubric answer through (hasRubric: false)', async () => {
    const { app } = makeFakes({ rubric: NO_RUBRIC });
    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/rubric/get', baseBody({ assignmentId: 7 }));
      expect(res.status).toBe(200);
      expect((res.body as { rubric: AssignmentRubric }).rubric.hasRubric).toBe(false);
    });
  });

  it('rejects bodies without an assignmentId', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/rubric/get', baseBody());
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_request');
    });
  });
});

// ---------------------------------------------------------------- /update ---

/** An edited criteria set: one existing row with its EXACT Canvas id, one
 * NEW row whose id is '' (the form builder later omits its id key). */
const EDITED_CRITERIA = [
  {
    id: '_4692',
    description: 'Thesis (revised)',
    long_description: 'Clear thesis',
    points: 6,
    learning_outcome_id: '7',
    ratings: [
      { id: 'blank', description: 'Full Marks', long_description: null, points: 6 },
      { id: '', description: 'Partial', long_description: null, points: 3 },
    ],
  },
  {
    id: '',
    description: 'New criterion',
    long_description: null,
    points: 5,
    learning_outcome_id: null,
    ratings: [{ id: '', description: 'Full Marks', long_description: null, points: 5 }],
  },
];

function updateBody(extra: Record<string, unknown> = {}) {
  return baseBody({
    assignmentId: 7,
    rubricId: 88,
    title: 'Essay Rubric v2',
    criteria: EDITED_CRITERIA,
    rubricAssociationId: 12,
    ...extra,
  });
}

describe('POST /course/rubric/update', () => {
  it('passes the criteria through EXACTLY and returns the re-fetched rubric', async () => {
    const { app, getCalls, updateCalls } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/rubric/update', updateBody());
      expect(res.status).toBe(200);
      expect((res.body as { ok: boolean }).ok).toBe(true);
      // The post-save re-fetch (the C# page's confirming LoadRubricAsync).
      expect((res.body as { rubric: AssignmentRubric }).rubric).toEqual(RUBRIC);
    });

    expect(updateCalls).toHaveLength(1);
    const call = updateCalls[0]!;
    expect(call.courseId).toBe(42);
    expect(call.rubricId).toBe(88);
    expect(call.args.title).toBe('Essay Rubric v2');
    expect(call.args.rubricAssociationId).toBe(12);
    // Exact pass-through: raw-string ids untouched, '' new-row markers kept.
    expect(call.args.criteria).toEqual(EDITED_CRITERIA);

    expect(getCalls).toEqual([{ courseId: 42, assignmentId: 7 }]); // update itself never pre-fetches
  });

  it('audits RubricUpdated with IDs/counts and the acting user', async () => {
    const { app, audits } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(
        base,
        '/course/rubric/update',
        updateBody({ actor: { canvasUserId: '553' } }),
      );
      expect(res.status).toBe(200);
    });
    expect(audits).toEqual([
      {
        action: 'RubricUpdated',
        fields: {
          canvasCourseId: 42,
          canvasAssignmentId: 7,
          rubricId: 88,
          rubricCriterionCount: 2,
          apiDomain: 'school.instructure.com',
          actorCanvasUserId: '553',
        },
      },
    ]);
  });

  it('omits the actor field from the audit when no actor is named', async () => {
    const { app, audits } = makeFakes();
    await withServer(app, async (base) => {
      await postJson(base, '/course/rubric/update', updateBody());
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.fields.actorCanvasUserId).toBeUndefined();
  });

  it('maps Canvas 4xx refusals to 409 with Canvas’s own message (no audit)', async () => {
    const { app, audits, updateCalls } = makeFakes({
      updateError: new CanvasError(
        400,
        'https://x/api/v1/courses/42/rubrics/88',
        JSON.stringify({ message: 'Cannot change an outcome-linked criterion' }),
      ),
    });
    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/rubric/update', updateBody());
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'canvas_rejected',
        message: 'Cannot change an outcome-linked criterion',
      });
    });
    expect(audits).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('maps Canvas 5xx to 502 and auth refusals to 422', async () => {
    const down = makeFakes({ updateError: new CanvasError(503, 'https://x', '') });
    await withServer(down.app, async (base) => {
      const res = await postJson(base, '/course/rubric/update', updateBody());
      expect(res.status).toBe(502);
      expect((res.body as { error: string }).error).toBe('canvas_error');
    });

    const denied = makeFakes({ updateError: new CanvasError(401, 'https://x', '') });
    await withServer(denied.app, async (base) => {
      const res = await postJson(base, '/course/rubric/update', updateBody());
      expect(res.status).toBe(422);
      expect((res.body as { error: string }).error).toBe('invalid_token');
    });
  });

  // Canvas REPLACES the criteria set — an empty save would wipe the rubric.
  it('rejects an empty criteria array', async () => {
    const { app, updateCalls } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/rubric/update', updateBody({ criteria: [] }));
      expect(res.status).toBe(400);
    });
    expect(updateCalls).toHaveLength(0);
  });

  it('rejects bodies missing the rubricId', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(
        base,
        '/course/rubric/update',
        baseBody({ assignmentId: 7, title: 'T', criteria: EDITED_CRITERIA }),
      );
      expect(res.status).toBe(400);
    });
  });
});
