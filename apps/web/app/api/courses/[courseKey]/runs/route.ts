// Grading runs for one course — the web tier relays to the in-process
// engine (the engine owns Canvas and every run mutation).
//
//   GET  — list the course's runs (engine GET /runs/list; filename metadata
//          only, no document downloads). Optional ?assignmentId= filter.
//          → { runs: [{runId, canvasAssignmentId, createdAt, filename}] }
//   POST { target: {kind, assignmentId, quizId?, discussionId?},
//          instructions?, regradeAll? }
//        — start a run (engine POST /runs/start). The faculty name comes
//          from the context's displayName (the teacher's own Canvas name).
//          → 202 { runId } | 422 …

import { NextResponse, type NextRequest } from 'next/server';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { z } from 'zod';
import { requireCourseStaff } from '../../../../../lib/auth/resolve-context';
import { HttpError } from '../../../../../lib/context/grading-context';
import { proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const startBody = z.object({
  target: z.object({
    kind: z.enum(['assignment', 'quiz', 'discussion']),
    assignmentId: z.number().int().positive(),
    quizId: z.number().int().positive().optional(),
    discussionId: z.number().int().positive().optional(),
  }),
  instructions: z.string().max(20_000).nullish(),
  regradeAll: z.boolean().optional(),
});

type Params = { params: Promise<{ courseKey: string }> };

function unauthorized(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json(
      { error: 'unauthorized', message: err.message },
      { status: err.status },
    );
  }
  throw err;
}

export async function GET(req: NextRequest, { params }: Params) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  try {
    await requireCourseStaff(courseKey);
  } catch (err) {
    return unauthorized(err);
  }

  const query = new URLSearchParams({ courseKey });
  const assignmentId = req.nextUrl.searchParams.get('assignmentId');
  if (assignmentId) query.set('assignmentId', assignmentId);

  const result = await engineFetch(`/runs/list?${query.toString()}`, undefined, {
    method: 'GET',
  });
  return proxyResponse(result);
}

export async function POST(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  let ctx;
  try {
    ctx = await requireCourseStaff(courseKey);
  } catch (err) {
    return unauthorized(err);
  }

  const parsed = startBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Invalid run-start body.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/runs/start', {
    courseKey,
    faculty: {
      canvasUserId: Number(ctx.user.canvasUserId ?? 0),
      name: ctx.user.displayName,
    },
    target: parsed.data.target,
    instructions: parsed.data.instructions ?? null,
    regradeAll: parsed.data.regradeAll === true,
  });
  return proxyResponse(result);
}
