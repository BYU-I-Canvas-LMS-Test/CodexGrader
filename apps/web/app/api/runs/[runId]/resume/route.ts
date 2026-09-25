// POST /api/runs/[runId]/resume?courseKey= — resume-on-open: rehydrate a
// checkpointed run in the engine and reconcile it against Canvas reality
// (EXTRACTING/SCORING→PENDING requeue, APPROVED-without-PostedAt matched
// against the Canvas score, resubmitted flags). PostedAt idempotency means a
// resume can never double-post. Course staff only.

import { type NextRequest } from 'next/server';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { authorizeRunAccess, proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const refused = browserMutationGuard(req, { accept: ['empty', 'json'] });
  if (refused) return refused;

  const { runId } = await params;
  const access = await authorizeRunAccess(req, runId, { staff: true });
  if (!access.ok) return access.response;

  // { takeOver: true } — explicitly take over a run another computer holds.
  const body = (await req.json().catch(() => null)) as { takeOver?: unknown } | null;
  const result = await engineFetch(`/runs/${encodeURIComponent(runId)}/resume`, {
    takeOver: body?.takeOver === true,
  });
  return proxyResponse(result);
}
