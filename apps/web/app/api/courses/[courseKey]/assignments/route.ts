// GET /api/courses/[courseKey]/assignments — the course's gradable items,
// bucketed + sorted by the engine (the engine owns Canvas;
// constraint 3). Requires a grading session for the course.

import { type NextRequest } from 'next/server';
import { requireGradingContext } from '../../../../../lib/auth/resolve-context';
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

  const result = await engineFetch('/course/assignments', courseEngineParams(access.ctx));
  return proxyResponse(result);
}
