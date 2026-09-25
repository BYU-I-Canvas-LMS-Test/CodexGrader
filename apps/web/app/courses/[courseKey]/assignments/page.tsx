// Assignments list (M4) — thin server component over the client view; the
// layout already resolved and gated the GradingContext.

import { AssignmentsView } from './assignments-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AssignmentsPage({
  params,
}: {
  params: Promise<{ courseKey: string }>;
}) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);
  return <AssignmentsView courseKey={courseKey} />;
}
