// /api/courses/[courseKey]/profile — the course AI Profile (AIGrader.json in
// the course's hidden Canvas folder; the engine owns the Canvas I/O).
//
//   GET  → { profile, exists }          (grading session required)
//   PUT  { …profile }                   → validate + save (course staff)
//   POST { fromCourseId }               → import another course's profile,
//                                         outcomes stripped (course staff)

import { NextResponse, type NextRequest } from 'next/server';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { z } from 'zod';
import {
  requireCourseStaff,
  requireGradingContext,
} from '../../../../../lib/auth/resolve-context';
import {
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

  const result = await engineFetch('/course/profile/get', courseEngineParams(access.ctx));
  return proxyResponse(result);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  const profile: unknown = await req.json().catch(() => null);
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'The request body must be a profile object.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/profile/save', {
    ...courseEngineParams(access.ctx),
    profile,
  });
  return proxyResponse(result);
}

const importBody = z.object({ fromCourseId: z.number().int().positive() });

export async function POST(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  const parsed = importBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'fromCourseId (positive integer) is required.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/profile/import', {
    ...courseEngineParams(access.ctx),
    fromCourseId: parsed.data.fromCourseId,
  });
  return proxyResponse(result);
}
