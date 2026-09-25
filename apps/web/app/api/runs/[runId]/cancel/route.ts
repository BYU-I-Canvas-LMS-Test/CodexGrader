// POST /api/runs/[runId]/cancel?courseKey= — cancel a run. The engine flags
// the progress doc + in-memory state, aborts in-flight LLM calls, and
// finalizes CANCELLED (or leaves the flag for the sweeper when the owning
// worker died). Never touches POSTED rows. Course staff only.

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

  const result = await engineFetch(`/runs/${encodeURIComponent(runId)}/cancel`, {});
  return proxyResponse(result);
}
