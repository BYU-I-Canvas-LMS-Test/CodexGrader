// Course dashboard — thin server component: resolves the GradingContext
// (shared with the layout via React cache()) and hands off to the client
// dashboard view.

import { redirect } from 'next/navigation';
import { getGradingContext } from '../../../lib/auth/resolve-context';
import { DashboardView } from './dashboard-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CourseDashboardPage({
  params,
}: {
  params: Promise<{ courseKey: string }>;
}) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const ctx = await getGradingContext(courseKey);
  if (!ctx) redirect('/?reason=no-session'); // layout already gates; belt and braces

  return <DashboardView courseKey={courseKey} isStaff={ctx.isCourseStaff} />;
}
