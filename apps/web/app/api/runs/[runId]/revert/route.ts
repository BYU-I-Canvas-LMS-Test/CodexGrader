// POST /api/runs/[runId]/revert?courseKey= — "revert to AI": discard the
// faculty edit on a DRAFT/EDITED row (the AI draft was never overwritten).
// Body: { userId, quizSubmissionId?, questionId? }. Course staff only.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { authorizeRunAccess, proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const revertBody = z.object({
  userId: z.number().int(),
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

  const parsed = revertBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Invalid revert body.' },
      { status: 400 },
    );
  }

  const result = await engineFetch(`/runs/${encodeURIComponent(runId)}/revert`, parsed.data);
  return proxyResponse(result);
}
