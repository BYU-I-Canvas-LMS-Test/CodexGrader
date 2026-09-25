// /course service endpoints: assignments bucketing + ordering shape, profile
// round-trip (never-null default → save → get), resources prep/upload
// round-trips, and the 15 MB upload cap. Canvas + stores are faked at the
// client-factory seam — route-level tests over real HTTP.

import { describe, expect, it } from 'vitest';
import express from 'express';
import type { CanvasAssignment, CanvasSubmission, QuizQuestion } from '@aigrader/canvas';
import {
  AssignmentPrepSettingsSchema,
  CourseSettingsProfileSchema,
  type AssignmentPrepSettings,
  type AssignmentResourceEntry,
  type CourseSettingsProfile,
  type ResourceKind,
} from '@aigrader/shared';
import {
  MAX_MATERIAL_BYTES,
  bucketAndSort,
  createCourseRouter,
  type CourseRouteClients,
} from '../src/course-routes.js';
import { postJson, withServer } from './helpers.js';


function baseBody(extra: Record<string, unknown> = {}) {
  return { apiDomain: 'school.instructure.com', courseId: 42, ...extra };
}

function assignment(partial: Partial<CanvasAssignment> & { id: number }): CanvasAssignment {
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

/** In-memory fakes satisfying the routes' structural ports. */
function makeFakes(overrides: {
  gradable?: CanvasAssignment[];
  detail?: CanvasAssignment;
  submissions?: CanvasSubmission[];
  quizQuestions?: QuizQuestion[];
  sourceProfiles?: Record<number, CourseSettingsProfile>;
} = {}) {
  const savedProfiles = new Map<number, CourseSettingsProfile>();
  for (const [id, p] of Object.entries(overrides.sourceProfiles ?? {})) {
    savedProfiles.set(Number(id), p);
  }
  const preps = new Map<string, AssignmentPrepSettings>();
  const materials = new Map<string, AssignmentResourceEntry & { bytes: Uint8Array }>();
  const factoryCalls: Array<{ apiDomain: string | null }> = [];

  const clients: CourseRouteClients = {
    canvas: {
      getGradableItems: async () => overrides.gradable ?? [],
      getAssignment: async (_c, id) => overrides.detail ?? assignment({ id }),
      getSubmissions: async () => overrides.submissions ?? [],
      getQuizQuestions: async () => overrides.quizQuestions ?? [],
    },
    profiles: {
      get: async (courseId) =>
        savedProfiles.get(courseId) ?? CourseSettingsProfileSchema.parse({}),
      exists: async (courseId) => savedProfiles.has(courseId),
      save: async (courseId, profile) => {
        savedProfiles.set(courseId, profile);
      },
      import: async (target, source) => {
        const src = savedProfiles.get(source);
        if (!src) return null;
        const copy = { ...src, canvasOutcomes: [] };
        savedProfiles.set(target, copy);
        return copy;
      },
    },
    resources: {
      list: async () => [...materials.values()].map(({ bytes: _b, ...entry }) => entry),
      uploadMaterial: async (
        _courseId,
        assignmentId,
        assignmentName,
        kind,
        originalFilename,
        contentType,
        bytes,
      ) => {
        const entry: AssignmentResourceEntry & { bytes: Uint8Array } = {
          canvasAssignmentId: assignmentId,
          assignmentName,
          kind,
          fileName: `a${assignmentId}-${kind.toLowerCase()}`,
          originalFilename,
          contentType,
          canvasFileId: 999,
          uploadedAt: '2026-07-27T00:00:00.000Z',
          bytes,
        };
        materials.set(`${assignmentId}:${kind}`, entry);
        const { bytes: _b, ...rest } = entry;
        return rest;
      },
      deleteMaterial: async (_courseId, assignmentId, kind: ResourceKind) => {
        materials.delete(`${assignmentId}:${kind}`);
      },
      getPrep: async (_courseId, assignmentId) =>
        preps.get(String(assignmentId)) ?? AssignmentPrepSettingsSchema.parse({}),
      savePrep: async (_courseId, assignmentId, prep) => {
        preps.set(String(assignmentId), prep);
      },
    },
  };

  const app = express();
  app.use(express.json({ limit: '21mb' }));
  app.use(
    '/course',
    createCourseRouter({
      clients: async (args) => {
        factoryCalls.push(args);
        return clients;
      },
    }),
  );
  return { app, factoryCalls, savedProfiles, preps, materials };
}

describe('POST /course/assignments', () => {
  it('buckets ready→upcoming→past, sorts within buckets, and shapes rows', async () => {
    const items = [
      assignment({ id: 1, name: 'Past B', has_submitted_submissions: true, due_at: '2026-01-01T00:00:00Z' }),
      assignment({ id: 2, name: 'Ready late', needs_grading_count: 3, due_at: '2026-06-02T00:00:00Z' }),
      assignment({ id: 3, name: 'Upcoming undated' }),
      assignment({
        id: 4,
        name: 'Quiz ready',
        submission_types: ['online_quiz'],
        quiz_id: 77,
        needs_grading_count: 1,
        due_at: '2026-06-01T00:00:00Z',
        rubric: [{ id: '_4692', description: 'Crit', long_description: null, points: 5, learning_outcome_id: null, ratings: null }],
      }),
      assignment({ id: 5, name: 'Past A', has_submitted_submissions: true, due_at: '2026-03-01T00:00:00Z' }),
      assignment({ id: 6, name: 'Upcoming dated', due_at: '2026-08-01T00:00:00Z' }),
    ];
    const { app, factoryCalls } = makeFakes({ gradable: items });

    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/assignments', baseBody());
      expect(res.status).toBe(200);
      const rows = (res.body as { assignments: Array<Record<string, unknown>> }).assignments;

      // ready (due asc) → upcoming (dated first, then undated) → past (desc)
      expect(rows.map((r) => r.id)).toEqual([4, 2, 6, 3, 5, 1]);
      expect(rows.map((r) => r.bucket)).toEqual([
        'ready_to_grade',
        'ready_to_grade',
        'upcoming',
        'upcoming',
        'past',
        'past',
      ]);

      const quizRow = rows[0]!;
      expect(quizRow).toMatchObject({
        id: 4,
        name: 'Quiz ready',
        itemType: 'quiz',
        quizId: 77,
        hasRubric: true,
        rubricCriteriaCount: 1,
        needsGradingCount: 1,
        published: true,
      });
    });

    expect(factoryCalls[0]).toEqual({
      apiDomain: 'school.instructure.com',
    });
  });

  it('rejects bodies without a courseId', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/assignments', { apiDomain: 'school.instructure.com' });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_request');
    });
  });
});

describe('bucketAndSort', () => {
  it('keeps undated items after dated ones in both directions', () => {
    const rows = bucketAndSort([
      assignment({ id: 1, name: 'z undated' }),
      assignment({ id: 2, name: 'a undated' }),
      assignment({ id: 3, due_at: '2026-05-01T00:00:00Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe('POST /course/assignment/detail', () => {
  it('returns assignment + raw-id rubric + submission counts + quiz info', async () => {
    const detail = assignment({
      id: 9,
      name: 'Essay quiz',
      submission_types: ['online_quiz'],
      quiz_id: 55,
      description: '<p>Write.</p>',
      rubric: [
        { id: '1745118159974', description: 'Depth', long_description: null, points: 12, learning_outcome_id: null, ratings: null },
      ],
    });
    const submissions = [
      { user_id: 1, workflow_state: 'submitted' },
      { user_id: 2, workflow_state: 'unsubmitted' },
      { user_id: 3, workflow_state: 'graded' },
    ] as CanvasSubmission[];
    const quizQuestions = [
      { id: 1, question_type: 'essay_question' },
      { id: 2, question_type: 'multiple_choice_question' },
      { id: 3, question_type: 'essay_question' },
    ] as QuizQuestion[];
    const { app } = makeFakes({ detail, submissions, quizQuestions });

    await withServer(app, async (base) => {
      const res = await postJson(base, '/course/assignment/detail', baseBody({ assignmentId: 9 }));
      expect(res.status).toBe(200);
      const body = res.body as Record<string, any>;
      expect(body.assignment.itemType).toBe('quiz');
      expect(body.assignment.rubric[0].id).toBe('1745118159974'); // raw string id
      expect(body.counts).toEqual({ total: 3, submitted: 2, gradable: 2 });
      expect(body.quiz).toEqual({ quizId: 55, aiGradableQuestions: 2, autoGradedQuestions: 1 });
    });
  });
});

describe('profile routes', () => {
  it('round-trips: default (exists:false) → save → get returns the saved profile', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const first = await postJson(base, '/course/profile/get', baseBody());
      expect(first.status).toBe(200);
      const firstBody = first.body as { profile: CourseSettingsProfile; exists: boolean };
      expect(firstBody.exists).toBe(false);
      expect(firstBody.profile.schemaVersion).toBe(1);
      expect(firstBody.profile.gradingDefaults.strictness).toBe(55); // defaulted

      const edited = {
        ...firstBody.profile,
        courseProfile: { ...firstBody.profile.courseProfile, gradingPhilosophy: 'Reward evidence.' },
        gradingDefaults: { ...firstBody.profile.gradingDefaults, strictness: 80 },
      };
      const save = await postJson(base, '/course/profile/save', baseBody({ profile: edited }));
      expect(save.status).toBe(200);

      const second = await postJson(base, '/course/profile/get', baseBody());
      const secondBody = second.body as { profile: CourseSettingsProfile; exists: boolean };
      expect(secondBody.exists).toBe(true);
      expect(secondBody.profile.gradingDefaults.strictness).toBe(80);
      expect(secondBody.profile.courseProfile.gradingPhilosophy).toBe('Reward evidence.');
    });
  });

  it('rejects a structurally invalid profile with 400 invalid_profile', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const res = await postJson(
        base,
        '/course/profile/save',
        baseBody({ profile: { schemaVersion: 2 } }), // future schema — refuse, do not coerce
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_profile');
    });
  });

  it('imports from a course with a profile and 404s when the source has none', async () => {
    const source = CourseSettingsProfileSchema.parse({
      courseProfile: { gradingPhilosophy: 'Source philosophy' },
      canvasOutcomes: [{ id: '_1', title: 'Outcome' }],
    });
    const { app } = makeFakes({ sourceProfiles: { 7: source } });
    await withServer(app, async (base) => {
      const ok = await postJson(base, '/course/profile/import', baseBody({ fromCourseId: 7 }));
      expect(ok.status).toBe(200);
      const imported = (ok.body as { profile: CourseSettingsProfile }).profile;
      expect(imported.courseProfile.gradingPhilosophy).toBe('Source philosophy');
      expect(imported.canvasOutcomes).toEqual([]); // outcomes never transfer

      const missing = await postJson(base, '/course/profile/import', baseBody({ fromCourseId: 8 }));
      expect(missing.status).toBe(404);
      expect((missing.body as { error: string }).error).toBe('no_source_profile');
    });
  });
});

describe('resource routes', () => {
  it('round-trips prep settings', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      const initial = await postJson(base, '/course/resources/get', baseBody({ assignmentId: 11 }));
      expect(initial.status).toBe(200);
      expect((initial.body as { prep: AssignmentPrepSettings }).prep).toMatchObject({
        shareRubric: true,
        shareInstructions: true,
      });

      const save = await postJson(
        base,
        '/course/resources/prep',
        baseBody({ assignmentId: 11, prep: { shareRubric: false, shareInstructions: true, customInstructions: 'Focus on citations.' } }),
      );
      expect(save.status).toBe(200);

      const after = await postJson(base, '/course/resources/get', baseBody({ assignmentId: 11 }));
      expect((after.body as { prep: AssignmentPrepSettings }).prep).toMatchObject({
        shareRubric: false,
        customInstructions: 'Focus on citations.',
      });
    });
  });

  it('uploads a material, lists it for its assignment only, and deletes it', async () => {
    const { app, materials } = makeFakes();
    await withServer(app, async (base) => {
      const bytes = Buffer.from('key-file-bytes');
      const up = await postJson(
        base,
        '/course/resources/upload',
        baseBody({
          assignmentId: 11,
          assignmentName: 'Lab 1',
          kind: 'KEY',
          filename: 'Key.XLSX',
          contentType: 'application/vnd.ms-excel',
          bytesBase64: bytes.toString('base64'),
        }),
      );
      expect(up.status).toBe(200);
      expect((up.body as { entry: AssignmentResourceEntry }).entry).toMatchObject({
        canvasAssignmentId: 11,
        kind: 'KEY',
        originalFilename: 'Key.XLSX',
      });
      expect(Buffer.from(materials.get('11:KEY')!.bytes).toString()).toBe('key-file-bytes');

      const listed = await postJson(base, '/course/resources/get', baseBody({ assignmentId: 11 }));
      expect((listed.body as { resources: unknown[] }).resources).toHaveLength(1);
      const other = await postJson(base, '/course/resources/get', baseBody({ assignmentId: 12 }));
      expect((other.body as { resources: unknown[] }).resources).toHaveLength(0);

      const del = await postJson(base, '/course/resources/delete', baseBody({ assignmentId: 11, kind: 'KEY' }));
      expect(del.status).toBe(200);
      const afterDelete = await postJson(base, '/course/resources/get', baseBody({ assignmentId: 11 }));
      expect((afterDelete.body as { resources: unknown[] }).resources).toHaveLength(0);
    });
  });

  it('rejects uploads over the 15 MB cap with 413 and bad base64 with 400', async () => {
    const { app } = makeFakes();
    await withServer(app, async (base) => {
      // Base64 that decodes to MAX+3 bytes (kept under the body-parser limit).
      const oversize = Buffer.alloc(MAX_MATERIAL_BYTES + 3, 7).toString('base64');
      const tooBig = await postJson(
        base,
        '/course/resources/upload',
        baseBody({
          assignmentId: 11,
          kind: 'KEY',
          filename: 'big.bin',
          contentType: 'application/octet-stream',
          bytesBase64: oversize,
        }),
      );
      expect(tooBig.status).toBe(413);
      expect((tooBig.body as { error: string }).error).toBe('file_too_large');

      const badChars = await postJson(
        base,
        '/course/resources/upload',
        baseBody({
          assignmentId: 11,
          kind: 'KEY',
          filename: 'x.bin',
          contentType: 'application/octet-stream',
          bytesBase64: '!!!not-base64!!!',
        }),
      );
      expect(badChars.status).toBe(400);
    });
  });
});
