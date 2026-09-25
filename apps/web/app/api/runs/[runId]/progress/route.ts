// GET /api/runs/[runId]/progress?courseKey= — the review UI's ~3s poll.
//
// The engine's local progress record (counts/status/heartbeat — never
// student content), after verifying the run belongs to the course the
// caller's GradingContext covers (lib/runs/run-access.ts).

import { NextResponse, type NextRequest } from 'next/server';
import { authorizeRunAccess } from '../../../../../lib/runs/run-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const access = await authorizeRunAccess(req, runId, { staff: false });
  if (!access.ok) return access.response;

  return NextResponse.json({ progress: access.progress });
}
