// POST /api/runs/[runId]/approve?courseKey= — approve drafts (or re-approve
// rows whose Canvas post failed) and enqueue their writeback. Body:
// { userIds?: number[], all?: true, reviewSeconds?: {userId: seconds} }.
// The APPROVER is the signed-in Canvas user (from the token's /users/self) —
// their name is the "[As Reviewed by …]" prefix; the request can't set it.
//
// THE human-in-the-loop gate: nothing posts to Canvas except grades a member
// of course staff approved HERE, by clicking in the review page. The browser
// mutation guard (session cookie + CSRF + exact Origin + Sec-Fetch-Site +
// JSON) runs first; only then does engineApprove — the one web-tier call that
// carries the engine's in-memory approval capability — run. No MCP tool and
// no other route can reach it.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { authorizeRunAccess, proxyResponse } from '../../../../../lib/runs/run-access';
import { engineApprove } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const approveBody = z
  .object({
    userIds: z.array(z.number().int()).max(1000).optional(),
    all: z.boolean().optional(),
    reviewSeconds: z.record(z.string(), z.number().nonnegative()).optional(),
  })
  .refine((b) => b.all === true || (b.userIds?.length ?? 0) > 0, {
    message: 'approve requires userIds or all:true',
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

  const parsed = approveBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'approve requires userIds or all:true.' },
      { status: 400 },
    );
  }

  const approverId = Number(access.ctx.user.canvasUserId);
  if (!Number.isInteger(approverId) || approverId <= 0) {
    return NextResponse.json(
      {
        error: 'approver_unknown',
        message: 'Could not confirm who you are in Canvas. Check your Canvas token, then reload.',
      },
      { status: 409 },
    );
  }

  const result = await engineApprove(runId, {
    ...parsed.data,
    approver: { canvasUserId: approverId, name: access.ctx.user.displayName },
  });
  return proxyResponse(result);
}
