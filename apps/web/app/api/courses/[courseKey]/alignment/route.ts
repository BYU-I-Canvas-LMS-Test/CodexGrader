// /api/courses/[courseKey]/alignment — the course alignment audit
// (alignment.json in the course's hidden Canvas folder; the engine owns the
// Canvas I/O and the model calls).
//
//   GET  → { latest, history }        (grading session required; when no
//                                      audit is saved the engine fills
//                                      `latest` with a live heuristic)
//   POST { method: 'heuristic'|'ai' } → run a review (course staff). The AI
//                                      review appends to history; the
//                                      heuristic is a live snapshot.

import { NextResponse, type NextRequest } from 'next/server';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { z } from 'zod';
import {
  requireCourseStaff,
  requireGradingContext,
} from '../../../../../lib/auth/resolve-context';
import {
  actorParams,
  courseEngineParams,
  resolveCourseAccess,
} from '../../../../../lib/courses/course-api';
import { proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ courseKey: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireGradingContext);
  if (!access.ok) return access.response;

  const result = await engineFetch('/alignment/report/get', courseEngineParams(access.ctx));
  return proxyResponse(result);
}

const runBody = z.object({ method: z.enum(['heuristic', 'ai']) });

export async function POST(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  const parsed = runBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: "method must be 'heuristic' or 'ai'." },
      { status: 400 },
    );
  }

  const result = await engineFetch('/alignment/run', {
    ...courseEngineParams(access.ctx),
    ...actorParams(access.ctx),
    method: parsed.data.method,
  });
  return proxyResponse(result);
}
