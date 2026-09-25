// /api/courses/[courseKey]/rubric proxy route: auth gates (GET needs a
// grading session, PUT needs course staff), worker body derivation (explicit
// params + EXACT criteria pass-through + actor threading), and error
// passthrough. resolve-context and the engine client are mocked at the module
// seam — the route handlers run for real.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The browser mutation guard has its own suite (approve-guard.test.ts);
// here it passes so the route logic is under test.
vi.mock('../lib/auth/local-session', () => ({
  browserMutationGuard: vi.fn(() => null),
}));
vi.mock('../lib/auth/resolve-context', () => ({
  requireGradingContext: vi.fn(),
  requireCourseStaff: vi.fn(),
}));
vi.mock('../lib/engine/client', () => ({
  engineFetch: vi.fn(),
  engineFetchRaw: vi.fn(),
}));

import {
  requireCourseStaff,
  requireGradingContext,
} from '../lib/auth/resolve-context';
import { engineFetch } from '../lib/engine/client';
import { HttpError, type GradingContext } from '../lib/context/grading-context';
import { GET as rubricGET, PUT as rubricPUT } from '../app/api/courses/[courseKey]/rubric/route';

const COURSE_KEY = 'byui.instructure.com#4242';
const RAW_KEY = encodeURIComponent(COURSE_KEY);

const mockGrading = vi.mocked(requireGradingContext);
const mockStaff = vi.mocked(requireCourseStaff);
const mockWorker = vi.mocked(engineFetch);

function ctxFixture(overrides: Partial<GradingContext> = {}): GradingContext {
  return {
    authSource: 'local',
    user: { displayName: 'Prof. Ada', canvasUserId: '553' },
    canvasBaseUrl: 'https://byui.instructure.com',
    courseId: '4242',
    courseKey: COURSE_KEY,
    courseName: 'Biology 101',
    roles: ['teacher'],
    isCourseStaff: true,
    ...overrides,
  };
}

const WORKER_PARAMS = {
  apiDomain: 'byui.instructure.com',
  courseId: 4242,
};

function params() {
  return { params: Promise.resolve({ courseKey: RAW_KEY }) };
}

function getReq(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/courses/${RAW_KEY}/rubric${query}`);
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/courses/${RAW_KEY}/rubric`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** An edited criteria set with a raw Canvas id and a '' new-row marker —
 * both must reach the worker byte-identical. */
const CRITERIA = [
  {
    id: '_4692',
    description: 'Thesis',
    long_description: null,
    points: 5,
    learning_outcome_id: '7',
    ratings: [{ id: 'blank', description: 'Full Marks', long_description: null, points: 5 }],
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

const PUT_BODY = {
  assignmentId: 7,
  rubricId: 88,
  title: 'Essay Rubric',
  criteria: CRITERIA,
  rubricAssociationId: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGrading.mockResolvedValue(ctxFixture());
  mockStaff.mockResolvedValue(ctxFixture());
  mockWorker.mockResolvedValue({ status: 200, body: { ok: true } });
});

describe('GET /api/courses/[courseKey]/rubric', () => {
  it('requires a grading session (401 passthrough, worker never called)', async () => {
    mockGrading.mockRejectedValue(new HttpError(401, 'No grading session for this course.'));
    const res = await rubricGET(getReq('?assignmentId=7'), params());
    expect(res.status).toBe(401);
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('requires a positive integer assignmentId', async () => {
    for (const q of ['', '?assignmentId=0', '?assignmentId=abc', '?assignmentId=-3']) {
      const res = await rubricGET(getReq(q), params());
      expect(res.status).toBe(400);
    }
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('maps onto the worker /course/rubric/get endpoint', async () => {
    mockWorker.mockResolvedValue({
      status: 200,
      body: { rubric: { hasRubric: true, rubricId: 88, shared: true } },
    });
    const res = await rubricGET(getReq('?assignmentId=7'), params());
    expect(mockWorker).toHaveBeenCalledWith('/course/rubric/get', {
      ...WORKER_PARAMS,
      assignmentId: 7,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rubric: { hasRubric: true, rubricId: 88, shared: true } });
  });
});

describe('PUT /api/courses/[courseKey]/rubric', () => {
  it('is staff-gated (403 passthrough, worker never called)', async () => {
    mockStaff.mockRejectedValue(new HttpError(403, 'This tool is limited to course staff.'));
    const res = await rubricPUT(putReq(PUT_BODY), params());
    expect(res.status).toBe(403);
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies before touching the worker', async () => {
    const missingRubricId = await rubricPUT(
      putReq({ ...PUT_BODY, rubricId: undefined }),
      params(),
    );
    expect(missingRubricId.status).toBe(400);
    const emptyCriteria = await rubricPUT(putReq({ ...PUT_BODY, criteria: [] }), params());
    expect(emptyCriteria.status).toBe(400);
    const notJson = await rubricPUT(
      new NextRequest(`http://localhost/api/courses/${RAW_KEY}/rubric`, {
        method: 'PUT',
        body: 'not json',
      }),
      params(),
    );
    expect(notJson.status).toBe(400);
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('maps the body onto /course/rubric/update with EXACT criteria + the actor', async () => {
    const res = await rubricPUT(putReq(PUT_BODY), params());
    expect(mockWorker).toHaveBeenCalledWith('/course/rubric/update', {
      ...WORKER_PARAMS,
      actor: { canvasUserId: '553' }, // from GradingContext.user.canvasUserId
      assignmentId: 7,
      rubricId: 88,
      title: 'Essay Rubric',
      criteria: CRITERIA, // raw ids and '' new-row markers untouched
      rubricAssociationId: 12,
    });
    expect(res.status).toBe(200);
  });

  it('omits the actor when the session has no Canvas user id', async () => {
    mockStaff.mockResolvedValue(
      ctxFixture({ user: { displayName: 'Prof. Ada' } }),
    );
    await rubricPUT(putReq(PUT_BODY), params());
    const body = mockWorker.mock.calls[0]![1] as Record<string, unknown>;
    expect('actor' in body).toBe(false);
  });

  it('defaults a missing rubricAssociationId to null', async () => {
    await rubricPUT(putReq({ ...PUT_BODY, rubricAssociationId: undefined }), params());
    const body = mockWorker.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.rubricAssociationId).toBeNull();
  });

  it('proxies worker refusals verbatim (Canvas 409 contract)', async () => {
    mockWorker.mockResolvedValue({
      status: 409,
      body: { error: 'canvas_rejected', message: 'Cannot change an outcome-linked criterion' },
    });
    const res = await rubricPUT(putReq(PUT_BODY), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'canvas_rejected',
      message: 'Cannot change an outcome-linked criterion',
    });
  });
});
