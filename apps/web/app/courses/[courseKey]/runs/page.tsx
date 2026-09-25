// Run history (M4) — thin server component over the client list; runs come
// from GET /api/courses/[courseKey]/runs (filename metadata only — opening a
// run downloads its document via the review screen).

import { RunsView } from './runs-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RunsPage({
  params,
}: {
  params: Promise<{ courseKey: string }>;
}) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);
  return <RunsView courseKey={courseKey} />;
}
