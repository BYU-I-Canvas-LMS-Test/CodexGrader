// /api/courses/[courseKey]/rubric — the in-app rubric editor's proxy (the
// worker owns all Canvas I/O).
//
//   GET ?assignmentId=N → { rubric } — the assignment's rubric for editing:
//                         criteria with their EXACT Canvas ids (raw-string
//                         round-trip rule) plus shared/otherAssignmentCount/
//                         sharedUnknown for the "edits affect other
//                         assignments" warning. Grading session required.
//   PUT { assignmentId, rubricId, title, criteria, rubricAssociationId? }
//                       → { ok, rubric } — save back to Canvas (Canvas
//                         REPLACES the criteria array, so the body carries
//                         every row; empty ids mark NEW rows). Course staff
//                         only; the actor rides along for the RubricUpdated
//                         audit. Canvas refusals proxy through as 409 with
//                         Canvas's own message.

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

export async function GET(req: NextRequest, { params }: Params) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireGradingContext);
  if (!access.ok) return access.response;

  const assignmentId = Number(req.nextUrl.searchParams.get('assignmentId'));
  if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'assignmentId must be a positive integer.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/rubric/get', {
    ...courseEngineParams(access.ctx),
    assignmentId,
  });
  return proxyResponse(result);
}

// Criterion/rating rows pass through EXACTLY as the editor built them — ids
// stay raw strings and are never reformatted; '' marks a NEW row (the canvas
// form builder omits its id key so Canvas mints a fresh one).
const ratingInput = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  long_description: z.string().nullish(),
  points: z.number(),
});

const criterionInput = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  long_description: z.string().nullish(),
  points: z.number(),
  learning_outcome_id: z.union([z.string(), z.number()]).nullish(),
  ratings: z.array(ratingInput).nullish(),
});

const putBody = z.object({
  assignmentId: z.number().int().positive(),
  rubricId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  criteria: z.array(criterionInput).min(1),
  rubricAssociationId: z.union([z.number(), z.string()]).nullish(),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  const parsed = putBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: 'invalid_request',
        message: issue
          ? `${issue.path.join('.') || 'body'}: ${issue.message}`
          : 'Invalid rubric body.',
      },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/rubric/update', {
    ...courseEngineParams(access.ctx),
    ...actorParams(access.ctx),
    assignmentId: parsed.data.assignmentId,
    rubricId: parsed.data.rubricId,
    title: parsed.data.title,
    criteria: parsed.data.criteria,
    rubricAssociationId: parsed.data.rubricAssociationId ?? null,
  });
  return proxyResponse(result);
}
