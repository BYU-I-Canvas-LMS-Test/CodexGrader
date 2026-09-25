// /api/courses/[courseKey]/alignment* proxy routes: auth gates (reads need a
// grading session, mutations need course staff), worker body derivation
// (explicit params + method/action mapping), the library GET's fan-out/merge,
// and error passthrough. resolve-context and the engine client are mocked at the
// module seam — the route handlers run for real.

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
import {
  GET as alignmentGET,
  POST as alignmentPOST,
} from '../app/api/courses/[courseKey]/alignment/route';
import {
  GET as outcomesGET,
  POST as outcomesPOST,
} from '../app/api/courses/[courseKey]/alignment/outcomes/route';

const COURSE_KEY = 'byui.instructure.com#4242';
const RAW_KEY = encodeURIComponent(COURSE_KEY);

const mockGrading = vi.mocked(requireGradingContext);
const mockStaff = vi.mocked(requireCourseStaff);
const mockWorker = vi.mocked(engineFetch);

function ctxFixture(overrides: Partial<GradingContext> = {}): GradingContext {
  return {
    authSource: 'local',
    user: { displayName: 'Prof. Ada' },
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
  return new NextRequest(`http://localhost/api/courses/${RAW_KEY}/alignment${query}`);
}

function postReq(body: unknown, path = ''): NextRequest {
  return new NextRequest(`http://localhost/api/courses/${RAW_KEY}/alignment${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGrading.mockResolvedValue(ctxFixture());
  mockStaff.mockResolvedValue(ctxFixture());
  mockWorker.mockResolvedValue({ status: 200, body: { ok: true } });
});

describe('GET /api/courses/[courseKey]/alignment', () => {
  it('requires a grading session (401 passthrough, worker never called)', async () => {
    mockGrading.mockRejectedValue(new HttpError(401, 'No grading session for this course.'));
    const res = await alignmentGET(getReq(), params());
    expect(res.status).toBe(401);
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('proxies the worker report with the explicit-params body', async () => {
    mockWorker.mockResolvedValue({
      status: 200,
      body: { latest: { method: 'heuristic' }, history: [] },
    });
    const res = await alignmentGET(getReq(), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/report/get', WORKER_PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ latest: { method: 'heuristic' }, history: [] });
  });
});

describe('POST /api/courses/[courseKey]/alignment', () => {
  it('is staff-gated (403 passthrough, worker never called)', async () => {
    mockStaff.mockRejectedValue(new HttpError(403, 'This tool is limited to course staff.'));
    const res = await alignmentPOST(postReq({ method: 'ai' }), params());
    expect(res.status).toBe(403);
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('rejects unknown methods before touching the worker', async () => {
    const res = await alignmentPOST(postReq({ method: 'vibes' }), params());
    expect(res.status).toBe(400);
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('maps the run body onto the worker /alignment/run endpoint', async () => {
    mockWorker.mockResolvedValue({ status: 200, body: { latest: { method: 'ai' } } });
    const res = await alignmentPOST(postReq({ method: 'ai' }), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/run', {
      ...WORKER_PARAMS,
      method: 'ai',
    });
    expect(res.status).toBe(200);
  });

  it('proxies worker errors verbatim', async () => {
    mockWorker.mockResolvedValue({
      status: 422,
      body: { error: 'invalid_token', message: 'Canvas did not accept the access token.' },
    });
    const res = await alignmentPOST(postReq({ method: 'heuristic' }), params());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });
});

describe('GET /api/courses/[courseKey]/alignment/outcomes', () => {
  it('defaults to the course list', async () => {
    mockWorker.mockResolvedValue({ status: 200, body: { outcomes: [] } });
    const res = await outcomesGET(getReq('/outcomes'), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/outcomes/course-list', WORKER_PARAMS);
    expect(res.status).toBe(200);
  });

  it('library root: resolves the root group, then merges subgroups + outcomes', async () => {
    mockWorker.mockImplementation(async (path) => {
      if (path === '/alignment/outcomes/library-root') {
        return { status: 200, body: { accountId: 2, group: { id: 100, title: 'Library' } } };
      }
      if (path === '/alignment/outcomes/library-subgroups') {
        return { status: 200, body: { accountId: 2, subgroups: [{ id: 101, title: 'Writing' }] } };
      }
      return { status: 200, body: { accountId: 2, outcomes: [{ id: 9, title: 'O', description: '' }] } };
    });

    const res = await outcomesGET(getReq('/outcomes?list=library'), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accountId: 2,
      group: { id: 100, title: 'Library' },
      subgroups: [{ id: 101, title: 'Writing' }],
      outcomes: [{ id: 9, title: 'O', description: '' }],
    });
    // Deeper levels reuse the accountId from the root call.
    expect(mockWorker).toHaveBeenCalledWith('/alignment/outcomes/library-subgroups', {
      ...WORKER_PARAMS,
      groupId: 100,
      accountId: 2,
    });
  });

  it('library level: fetches the requested group without re-resolving the root', async () => {
    mockWorker.mockImplementation(async (path) =>
      path === '/alignment/outcomes/library-subgroups'
        ? { status: 200, body: { accountId: 2, subgroups: [] } }
        : { status: 200, body: { accountId: 2, outcomes: [] } },
    );

    const res = await outcomesGET(getReq('/outcomes?list=library&groupId=101&accountId=2'), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: 2, group: null, subgroups: [], outcomes: [] });
    expect(mockWorker).toHaveBeenCalledTimes(2);
    expect(mockWorker).not.toHaveBeenCalledWith('/alignment/outcomes/library-root', expect.anything());
  });

  it('propagates a failed root lookup instead of merging garbage', async () => {
    mockWorker.mockResolvedValue({ status: 404, body: { error: 'no_account' } });
    const res = await outcomesGET(getReq('/outcomes?list=library'), params());
    expect(res.status).toBe(404);
    expect(mockWorker).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown list values', async () => {
    const res = await outcomesGET(getReq('/outcomes?list=everything'), params());
    expect(res.status).toBe(400);
    expect(mockWorker).not.toHaveBeenCalled();
  });
});

describe('POST /api/courses/[courseKey]/alignment/outcomes', () => {
  it('is staff-gated', async () => {
    mockStaff.mockRejectedValue(new HttpError(403, 'This tool is limited to course staff.'));
    const res = await outcomesPOST(postReq({ action: 'link', outcomeId: 9 }, '/outcomes'), params());
    expect(res.status).toBe(403);
    expect(mockWorker).not.toHaveBeenCalled();
  });

  it('maps link/unlink onto their worker endpoints', async () => {
    await outcomesPOST(postReq({ action: 'link', outcomeId: 9 }, '/outcomes'), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/outcomes/link', {
      ...WORKER_PARAMS,
      outcomeId: 9,
    });

    await outcomesPOST(postReq({ action: 'unlink', outcomeId: 4 }, '/outcomes'), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/outcomes/unlink', {
      ...WORKER_PARAMS,
      outcomeId: 4,
    });
  });

  it('maps create (description defaults to empty)', async () => {
    await outcomesPOST(postReq({ action: 'create', title: 'New' }, '/outcomes'), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/outcomes/create', {
      ...WORKER_PARAMS,
      title: 'New',
      description: '',
    });
  });

  it('rejects malformed actions', async () => {
    const bad = await outcomesPOST(postReq({ action: 'link' }, '/outcomes'), params());
    expect(bad.status).toBe(400);
    const unknown = await outcomesPOST(postReq({ action: 'destroy', outcomeId: 1 }, '/outcomes'), params());
    expect(unknown.status).toBe(400);
    expect(mockWorker).not.toHaveBeenCalled();
  });
});

describe('actor threading (mutations carry the acting Canvas user id)', () => {
  const CTX_WITH_ACTOR = ctxFixture({
    user: { displayName: 'Prof. Ada', canvasUserId: '553' },
  });

  it('POST alignment forwards actor from GradingContext.user.canvasUserId', async () => {
    mockStaff.mockResolvedValue(CTX_WITH_ACTOR);
    await alignmentPOST(postReq({ method: 'ai' }), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/run', {
      ...WORKER_PARAMS,
      actor: { canvasUserId: '553' },
      method: 'ai',
    });
  });

  it('POST outcomes forwards actor on link and create', async () => {
    mockStaff.mockResolvedValue(CTX_WITH_ACTOR);
    await outcomesPOST(postReq({ action: 'link', outcomeId: 9 }, '/outcomes'), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/outcomes/link', {
      ...WORKER_PARAMS,
      actor: { canvasUserId: '553' },
      outcomeId: 9,
    });
    await outcomesPOST(postReq({ action: 'create', title: 'New' }, '/outcomes'), params());
    expect(mockWorker).toHaveBeenCalledWith('/alignment/outcomes/create', {
      ...WORKER_PARAMS,
      actor: { canvasUserId: '553' },
      title: 'New',
      description: '',
    });
  });

  it('omits actor entirely when the session has no Canvas user id', async () => {
    // Default ctxFixture has no canvasUserId — covered by the mapping tests
    // above asserting bodies WITHOUT an actor key; spot-check explicitly:
    await outcomesPOST(postReq({ action: 'unlink', outcomeId: 4 }, '/outcomes'), params());
    const body = mockWorker.mock.calls[0]![1] as Record<string, unknown>;
    expect('actor' in body).toBe(false);
  });
});
