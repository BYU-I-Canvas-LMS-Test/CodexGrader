// GET /api/runs/[runId]/snapshot?courseKey= — the full run document for the
// review screen (live engine session first, else the Canvas checkpoint).
// Relayed to the engine: the document carries student excerpts, which only
// ever transit Canvas ↔ engine ↔ this authenticated response — never any
// other store. Course staff only.

import { type NextRequest } from 'next/server';
import { authorizeRunAccess, proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const access = await authorizeRunAccess(req, runId, { staff: true });
  if (!access.ok) return access.response;

  const result = await engineFetch(`/runs/${encodeURIComponent(runId)}/snapshot`, undefined, {
    method: 'GET',
  });
  return proxyResponse(result);
}
