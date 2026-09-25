// Run review screen (M4) — thin server component. The client view polls
// /api/runs/[runId]/progress (~3s while active) and pulls the run document
// via /snapshot; both routes re-verify the courseKey against the caller's
// GradingContext, so the page only needs to resolve identity.

import { redirect } from 'next/navigation';
import { getGradingContext } from '../../../../../lib/auth/resolve-context';
import { RunReviewView } from './run-review-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RunReviewPage({
  params,
}: {
  params: Promise<{ courseKey: string; runId: string }>;
}) {
  const { courseKey: rawKey, runId: rawRunId } = await params;
  const courseKey = decodeURIComponent(rawKey);
  const runId = decodeURIComponent(rawRunId);

  const ctx = await getGradingContext(courseKey);
  if (!ctx) redirect('/signin');

  return (
    <RunReviewView
      courseKey={courseKey}
      runId={runId}
      viewerName={ctx.user.displayName}
      isStaff={ctx.isCourseStaff}
    />
  );
}
