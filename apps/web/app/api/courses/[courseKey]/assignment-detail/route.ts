// GET /api/courses/[courseKey]/assignment-detail?assignmentId= — one
// assignment with its rubric snapshot (raw criterion ids), submission counts,
// and quiz essay-question info, for the Prepare screen. Engine-relayed.

import { NextResponse, type NextRequest } from 'next/server';
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

export async function GET(req: NextRequest, { params }: Params) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireGradingContext);
  if (!access.ok) return access.response;

  const assignmentId = Number(req.nextUrl.searchParams.get('assignmentId'));
  if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'assignmentId query parameter is required.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/assignment/detail', {
    ...courseEngineParams(access.ctx),
    assignmentId,
  });
  return proxyResponse(result);
}
