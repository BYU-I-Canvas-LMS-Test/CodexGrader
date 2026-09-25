// POST /api/runs/[runId]/edit?courseKey= — record a faculty edit on the live
// run session (worker flushes on the ~3s edit tier: human work is the
// expensive thing to lose). Body: { userId, facultyEdited,
// quizSubmissionId?, questionId? }. Course staff only; proxied — the engine
// owns every run mutation.

import { NextResponse, type NextRequest } from 'next/server';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { z } from 'zod';
import { authorizeRunAccess, proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const editBody = z.object({
  userId: z.number().int(),
  facultyEdited: z.unknown(),
  quizSubmissionId: z.number().int().optional(),
  questionId: z.number().int().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { runId } = await params;
  const access = await authorizeRunAccess(req, runId, { staff: true });
  if (!access.ok) return access.response;

  const parsed = editBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Invalid edit body.' },
      { status: 400 },
    );
  }

  const result = await engineFetch(`/runs/${encodeURIComponent(runId)}/edit`, {
    ...parsed.data,
    source: 'browser',
  });
  return proxyResponse(result);
}
