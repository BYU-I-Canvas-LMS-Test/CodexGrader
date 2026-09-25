// Shared plumbing for the /api/courses/[courseKey]/* routes.
//
// Contract: the web tier NEVER talks to Canvas — it resolves the caller's
// GradingContext, translates it into the engine's explicit-params body
// ({apiDomain, courseId}), and relays the engine's answer. Reads require a
// review session; mutations additionally require course staff (the routes
// pick the resolver).

import 'server-only';

import { NextResponse } from 'next/server';
import { parseCourseKey } from '@aigrader/shared';
import { HttpError, type GradingContext } from '../context/grading-context';

/** A course-scoped resolver — requireGradingContext / requireCourseStaff
 * shaped; injectable so the auth mapping is testable without cookies. */
export type CourseResolver = (courseKey: string) => Promise<GradingContext>;

export type CourseAccess =
  | { ok: true; ctx: GradingContext }
  | { ok: false; response: NextResponse };

/** Resolve the caller's context for a course, mapping auth failures
 * (HttpError 401/403) onto JSON responses; anything else propagates. */
export async function resolveCourseAccess(
  courseKey: string,
  resolver: CourseResolver,
): Promise<CourseAccess> {
  try {
    return { ok: true, ctx: await resolver(courseKey) };
  } catch (err) {
    if (err instanceof HttpError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'unauthorized', message: err.message },
          { status: err.status },
        ),
      };
    }
    throw err;
  }
}

/** The engine /course/* base body derived from a GradingContext. The
 * apiDomain is the courseKey's host — the course address names the Canvas
 * instance the course lives on (same rule the run engine applies). */
export function courseEngineParams(ctx: GradingContext): {
  apiDomain: string;
  courseId: number;
} {
  return {
    apiDomain: parseCourseKey(ctx.courseKey).host,
    courseId: Number(ctx.courseId),
  };
}

/** The optional engine `actor` body field for mutation routes: names the
 * acting faculty member by Canvas user id (IDs only — never a name) so audit
 * events can record who acted. Empty when the Canvas user id is unknown
 * (audit() drops absent fields, so omission is safe). */
export function actorParams(ctx: GradingContext): { actor?: { canvasUserId: string } } {
  return ctx.user.canvasUserId ? { actor: { canvasUserId: ctx.user.canvasUserId } } : {};
}
