// POST /api/runs/[runId]/rerun?courseKey= — re-grade rows (a failed
// extraction, a student who resubmitted, a draft the teacher wants redone).
// Body: { userIds?: number[], quizItems?: [{quizSubmissionId, questionId}] }.
// Only ERROR/DRAFT/EDITED rows re-run; a kept faculty edit is flagged stale
// when the new AI draft lands. Grading only — nothing posts. Course staff.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { authorizeRunAccess, proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rerunBody = z
  .object({
    userIds: z.array(z.number().int()).max(1000).optional(),
    quizItems: z
      .array(z.object({ quizSubmissionId: z.number().int(), questionId: z.number().int() }))
      .max(5000)
      .optional(),
  })
  .refine((b) => (b.userIds?.length ?? 0) + (b.quizItems?.length ?? 0) > 0, {
    message: 'rerun requires userIds or quizItems',
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

  const parsed = rerunBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'rerun requires userIds or quizItems.' },
      { status: 400 },
    );
  }

  const result = await engineFetch(`/runs/${encodeURIComponent(runId)}/rerun`, parsed.data);
  return proxyResponse(result);
}
