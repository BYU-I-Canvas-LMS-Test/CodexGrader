// Course shell: server component resolving the GradingContext (local review
// session + Canvas-confirmed staff seat), wrapping the faculty pages in the
// sidebar chrome + FluentProvider.
// Nav structure ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\
// Layout\LtiLayout.razor (Dashboard, Assignments, Course AI Profile,
// Outcomes & Alignment, Help + user chip footer; Grading Runs added).

import { redirect } from 'next/navigation';
import { getGradingContext } from '../../../lib/auth/resolve-context';
import { CourseProviders } from './_components/providers';
import { CourseSidebar } from './_components/sidebar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function roleLabelFor(roles: string[], isStaff: boolean): string {
  if (!isStaff) return 'No grading access';
  const role = roles[0];
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Course staff';
}

export default async function CourseLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ courseKey: string }>;
}) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const ctx = await getGradingContext(courseKey);
  if (!ctx) {
    // No review session (or not staff here) — the home page explains how to
    // open the grader from Codex.
    redirect('/?reason=no-session');
  }

  return (
    <CourseProviders>
      <div className="app">
        <CourseSidebar
          courseKey={courseKey}
          courseId={ctx.courseId}
          courseName={ctx.courseName}
          displayName={ctx.user.displayName}
          roleLabel={roleLabelFor(ctx.roles, ctx.isCourseStaff)}
        />
        <main className="main">{children}</main>
      </div>
    </CourseProviders>
  );
}
