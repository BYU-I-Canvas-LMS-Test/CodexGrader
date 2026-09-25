// Prepare & grade screen (M4) — thin server component resolving the context
// (the client view needs canvasBaseUrl/courseId for its "View in Canvas"
// deep links and the staff flag to gate mutations).

import { redirect } from 'next/navigation';
import { getGradingContext } from '../../../../../../lib/auth/resolve-context';
import { PrepareView } from './prepare-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PreparePage({
  params,
}: {
  params: Promise<{ courseKey: string; assignmentId: string }>;
}) {
  const { courseKey: rawKey, assignmentId } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const ctx = await getGradingContext(courseKey);
  if (!ctx) redirect('/signin');

  const id = Number(assignmentId);
  if (!Number.isInteger(id) || id <= 0) redirect(`/courses/${encodeURIComponent(courseKey)}/assignments`);

  return (
    <PrepareView
      courseKey={courseKey}
      assignmentId={id}
      courseId={ctx.courseId}
      canvasBaseUrl={ctx.canvasBaseUrl}
      isStaff={ctx.isCourseStaff}
    />
  );
}
