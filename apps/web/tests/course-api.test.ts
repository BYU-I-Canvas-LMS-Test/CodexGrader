// /api/courses/[courseKey]/* relay plumbing: auth-failure → response
// mapping (context required; the staff gate rides the injected resolver),
// the engine body derivation (apiDomain from the courseKey host, courseId
// numeric, never any token material), and actor threading.

import { describe, expect, it } from 'vitest';
import {
  actorParams,
  courseEngineParams,
  resolveCourseAccess,
} from '../lib/courses/course-api';
import {
  HttpError,
  type GradingContext,
} from '../lib/context/grading-context';

const COURSE_KEY = 'byui.instructure.com#4242';

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

describe('resolveCourseAccess', () => {
  it('passes the resolved context through', async () => {
    const ctx = ctxFixture();
    const access = await resolveCourseAccess(COURSE_KEY, async () => ctx);
    expect(access).toEqual({ ok: true, ctx });
  });

  it('maps a missing grading session (401) onto a JSON response', async () => {
    const access = await resolveCourseAccess(COURSE_KEY, async () => {
      throw new HttpError(401, 'No grading session for this course.');
    });
    expect(access.ok).toBe(false);
    if (access.ok) throw new Error('expected failure');
    expect(access.response.status).toBe(401);
    const body = (await access.response.json()) as { error: string; message: string };
    expect(body.error).toBe('unauthorized');
    expect(body.message).toContain('No grading session');
  });

  it('maps the staff gate (403) onto a JSON response', async () => {
    // Mutations pass requireCourseStaff as the resolver; a non-staff caller
    // surfaces as HttpError(403) and must never reach the engine.
    const access = await resolveCourseAccess(COURSE_KEY, async () => {
      throw new HttpError(403, 'This tool is limited to course staff.');
    });
    expect(access.ok).toBe(false);
    if (access.ok) throw new Error('expected failure');
    expect(access.response.status).toBe(403);
  });

  it('lets non-auth failures propagate (500s are not auth responses)', async () => {
    await expect(
      resolveCourseAccess(COURSE_KEY, async () => {
        throw new Error('engine exploded');
      }),
    ).rejects.toThrow('engine exploded');
  });
});

describe('courseEngineParams', () => {
  it('derives apiDomain from the courseKey host and keeps ids numeric', () => {
    expect(courseEngineParams(ctxFixture())).toEqual({
      apiDomain: 'byui.instructure.com',
      courseId: 4242,
    });
  });

  it('never carries token material', () => {
    const params = courseEngineParams(ctxFixture());
    expect(JSON.stringify(params)).not.toMatch(/token/i);
  });
});

describe('actorParams', () => {
  it('names the acting Canvas user by id only', () => {
    expect(actorParams(ctxFixture({ user: { displayName: 'Prof. Ada', canvasUserId: '553' } }))).toEqual({
      actor: { canvasUserId: '553' },
    });
  });

  it('is empty when the Canvas user id is unknown', () => {
    expect(actorParams(ctxFixture())).toEqual({});
  });
});
