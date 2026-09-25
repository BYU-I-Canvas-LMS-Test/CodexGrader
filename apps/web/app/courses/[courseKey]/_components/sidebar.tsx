'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Layout\LtiLayout.razor
// (the ink sidebar shell: brand, nav, Canvas pill, user chip — itself a port
// of the TS app's app/lti sidebar); routes are course-scoped
// (/courses/[courseKey]/…) instead of /lti.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { I } from './icons';

/** Two-letter initials for the avatar chip (same rule as the C# Initials /
 * TS initialsFrom()). */
function initialsFrom(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return '–';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

export function CourseSidebar({
  courseKey,
  courseId,
  courseName,
  displayName,
  roleLabel,
}: {
  courseKey: string;
  courseId: string;
  courseName: string;
  displayName: string;
  roleLabel: string;
}) {
  const pathname = usePathname();
  const base = `/courses/${encodeURIComponent(courseKey)}`;

  const items = [
    { href: base, label: 'Dashboard', icon: <I.Home />, exact: true },
    { href: `${base}/assignments`, label: 'Assignments', icon: <I.Doc /> },
    { href: `${base}/runs`, label: 'Grading Runs', icon: <I.List /> },
    { href: `${base}/profile`, label: 'Course AI Profile', icon: <I.Smile /> },
    { href: `${base}/outcomes`, label: 'Outcomes & Alignment', icon: <I.Target /> },
    { href: `${base}/help`, label: 'Help & Resources', icon: <I.Help /> },
  ];

  function isActive(item: { href: string; exact?: boolean }): boolean {
    if (!pathname) return false;
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="logomark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/aigrader-white-square.png" alt="" aria-hidden />
        </span>
        <span className="name">BYU-(A)I Grader</span>
      </div>
      <nav aria-label="Course navigation">
        {items.map((item) => (
          <Link
            key={item.href}
            className={'nav-item' + (isActive(item) ? ' active' : '')}
            href={item.href}
            aria-current={isActive(item) ? 'page' : undefined}
          >
            <span className="ico">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="spacer" />
      <div className="canvas-pill">
        <div className="row">
          <I.Canvas w={15} h={15} /> Connected to Canvas
        </div>
        <div className="course">
          <span title={`Course ${courseId}`}>{courseName}</span>
        </div>
      </div>
      <div className="user-card">
        <div className="avatar" aria-hidden>
          {initialsFrom(displayName)}
        </div>
        <div style={{ textAlign: 'left' }}>
          <div className="name">{displayName}</div>
          <div className="role">{roleLabel}</div>
        </div>
      </div>
    </aside>
  );
}
