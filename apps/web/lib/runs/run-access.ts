// Shared authorization for the /api/runs/[runId]/* routes.
//
// Contract: the web tier NEVER trusts a bare runId. Every run route requires
// a `courseKey` query param, resolves the caller's GradingContext for that
// course, and then verifies the run belongs to that course: the engine's
// local progress record must carry the same courseKey, or — for a run this
// machine has never seen (a co-instructor's, or one the C# app wrote) — the
// engine must find it in THAT course's Canvas folder (engine.adopt). A runId
// from another course (or a guessed one) 404s without revealing anything.

import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import {
  requireCourseStaff,
  requireGradingContext,
} from '../auth/resolve-context';
import { HttpError, type GradingContext } from '../context/grading-context';
import { engineFetch } from '../engine/client';

export type RunAccess =
  | { ok: true; ctx: GradingContext; courseKey: string; progress: Record<string, unknown> }
  | { ok: false; response: NextResponse };

const notFound = () =>
  NextResponse.json(
    { error: 'not_found', message: 'No such run for this course.' },
    { status: 404 },
  );

/**
 * Resolves + authorizes access to one run. `staff: true` (mutations) enforces
 * the course-staff boundary; reads still require a review session.
 */
export async function authorizeRunAccess(
  req: NextRequest,
  runId: string,
  opts: { staff: boolean },
): Promise<RunAccess> {
  const courseKey = req.nextUrl.searchParams.get('courseKey');
  if (!courseKey) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'invalid_request', message: 'courseKey query parameter is required.' },
        { status: 400 },
      ),
    };
  }

  let ctx: GradingContext;
  try {
    ctx = opts.staff
      ? await requireCourseStaff(courseKey)
      : await requireGradingContext(courseKey);
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

  const encoded = encodeURIComponent(runId);
  let res = await engineFetch(`/runs/${encoded}/progress`, null, { method: 'GET' });
  if (res.status === 404) {
    // Unknown here — open it from THIS course's folder (never another's).
    res = await engineFetch(`/runs/${encoded}/adopt`, { courseKey });
  }
  if (res.status !== 200) return { ok: false, response: notFound() };

  const progress = (res.body as { progress?: Record<string, unknown> }).progress;
  // A missing record and a courseKey mismatch answer identically.
  if (!progress || progress.courseKey !== courseKey) {
    return { ok: false, response: notFound() };
  }

  return { ok: true, ctx, courseKey, progress };
}

/** Relays an engine response { status, body } straight through. */
export function proxyResponse(result: { status: number; body: unknown }): NextResponse {
  return NextResponse.json((result.body ?? {}) as Record<string, unknown>, {
    status: result.status,
  });
}
