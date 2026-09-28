'use client';

// The local course picker. The teacher's Canvas access comes from their own
// ~/.aigrader/.env (CANVAS_BASE_URL + CANVAS_API_TOKEN); this page lists the
// courses on each configured Canvas instance where Canvas says they are a
// teacher, TA, or designer as cards (course image, name, code, term,
// needs-grading count), verifies the pick with Canvas, and opens
// /courses/{courseKey}. Unpublished and ended courses wait behind "All
// courses".

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { I } from '../courses/[courseKey]/_components/icons';
import './connect.css';

interface CourseRow {
  id: number;
  name: string;
  courseCode: string | null;
  enrollmentRole: string;
  termName: string | null;
  imageUrl: string | null;
  needsGradingCount: number | null;
  published: boolean;
  ended: boolean;
}

interface InstanceRow {
  host: string;
  baseUrl: string;
  canvasUserName: string | null;
  courses: CourseRow[];
  error?: string;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; instances: InstanceRow[] }
  | { kind: 'no_session'; message: string }
  | { kind: 'not_configured'; message: string }
  | { kind: 'error'; message: string };

const ROLE_LABELS: Record<string, string> = { teacher: 'Teacher', ta: 'TA', designer: 'Designer' };

/** Fallback circle colors when a course has no image (picked by course id). */
const AVATAR_COLORS = ['#006eb6', '#0f8f7e', '#e0663a', '#7c5ce0', '#d0487a', '#2f8a4c'];

const isCurrent = (course: CourseRow) => course.published && !course.ended;

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? 'Something went wrong. Try again.';
}

/** Up to two letters from the course name's words, for the fallback circle. */
function initialsFor(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (words.length === 0) return '#';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

function CourseAvatar({ course }: { course: CourseRow }) {
  const [broken, setBroken] = useState(false);
  const color = AVATAR_COLORS[course.id % AVATAR_COLORS.length];
  return (
    <span className="course-avatar" style={{ background: color }} aria-hidden>
      {course.imageUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={course.imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        initialsFor(course.name)
      )}
    </span>
  );
}

function CourseCard({
  course,
  opening,
  disabled,
  onOpen,
}: {
  course: CourseRow;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const count = course.needsGradingCount;
  return (
    <button
      type="button"
      className="course-card"
      onClick={onOpen}
      disabled={disabled}
      aria-busy={opening}
    >
      <CourseAvatar course={course} />
      {!course.published || course.ended ? (
        <span className="course-badges">
          {!course.published ? <span className="course-badge unpublished">Unpublished</span> : null}
          {course.ended ? <span className="course-badge">Ended</span> : null}
        </span>
      ) : null}
      <span className="course-body">
        <span className="course-name">{course.name}</span>
        <span className="course-meta">
          <I.Tag w={15} h={15} />
          {course.courseCode ?? 'No course code'}
        </span>
        <span className="course-meta">
          <I.Calendar w={15} h={15} />
          {course.termName ?? 'No term'}
        </span>
      </span>
      <span className="course-foot">
        <span className="course-stat">
          <span className="label">Your role</span>
          <span className="value">{ROLE_LABELS[course.enrollmentRole] ?? course.enrollmentRole}</span>
        </span>
        <span className="course-stat right">
          <span className="label">Needs grading</span>
          <span className={`value count ${count ? 'pending' : ''}`}>{count ?? '—'}</span>
        </span>
      </span>
      {opening ? <span className="course-opening">Checking your enrollment…</span> : null}
    </button>
  );
}

export default function CoursePickerPage() {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [showAll, setShowAll] = useState(false);
  const [opening, setOpening] = useState<{ host: string; id: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/canvas/courses', { cache: 'no-store' }).catch(() => null);
      if (!res) {
        setLoad({ kind: 'error', message: 'Could not reach the local grader. Is it still running?' });
        return;
      }
      if (res.status === 401) {
        setLoad({ kind: 'no_session', message: await readError(res) });
        return;
      }
      if (res.status === 409) {
        setLoad({ kind: 'not_configured', message: await readError(res) });
        return;
      }
      if (!res.ok) {
        setLoad({ kind: 'error', message: await readError(res) });
        return;
      }
      const { instances } = (await res.json()) as { instances: InstanceRow[] };
      setLoad({ kind: 'ready', instances });
    })();
  }, []);

  function openCourse(host: string, id: number) {
    setOpening({ host, id });
    setError(null);
    void (async () => {
      try {
        const res = await fetch('/api/canvas/courses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host, courseId: id }),
        });
        if (!res.ok) {
          setError(await readError(res));
          setOpening(null);
          return;
        }
        const { courseKey } = (await res.json()) as { courseKey: string };
        // Leave the card in its "checking" state while the course loads.
        router.push(`/courses/${encodeURIComponent(courseKey)}`);
      } catch {
        setError('Could not reach the local grader. Is it still running?');
        setOpening(null);
      }
    })();
  }

  const nav = (
    <nav className="connect-nav">
      <Link className="brand" href="/connect">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/aigrader-white-square.png" alt="" aria-hidden />
        <span>BYU-(A)I Grader</span>
      </Link>
    </nav>
  );
  const footer = <p className="connect-footer">BYU-Idaho · Instructional Technology</p>;

  if (load.kind === 'ready') {
    const all = load.instances.flatMap((i) => i.courses);
    const currentCount = all.filter(isCurrent).length;
    return (
      <div className="connect">
        {nav}
        <main className="picker">
          <header className="picker-head">
            <h1>Pick a course to grade</h1>
            <p className="sub">
              Courses where Canvas lists you as a teacher, TA, or designer. Everything you
              approve here posts to Canvas under your own account.
            </p>
          </header>

          <div className="picker-filters" role="group" aria-label="Which courses to show">
            <button
              type="button"
              className="picker-filter"
              aria-pressed={!showAll}
              onClick={() => setShowAll(false)}
            >
              Current <span className="count">{currentCount}</span>
            </button>
            <button
              type="button"
              className="picker-filter"
              aria-pressed={showAll}
              onClick={() => setShowAll(true)}
            >
              All courses <span className="count">{all.length}</span>
            </button>
          </div>

          {error ? (
            <p className="connect-error" role="alert">
              {error}
            </p>
          ) : null}

          {load.instances.map((instance) => {
            // Current courses first, each group in the engine's name order.
            const visible = showAll
              ? [...instance.courses.filter(isCurrent), ...instance.courses.filter((c) => !isCurrent(c))]
              : instance.courses.filter(isCurrent);
            const hidden = instance.courses.length - visible.length;
            return (
              <section key={instance.host} className="picker-instance">
                <div className="picker-instance-head">
                  <h2>{instance.host}</h2>
                  {instance.canvasUserName ? (
                    <span className="who">
                      Signed in to Canvas as <strong>{instance.canvasUserName}</strong>
                    </span>
                  ) : null}
                </div>
                {instance.error ? (
                  <div className="connect-empty">{instance.error}</div>
                ) : instance.courses.length === 0 ? (
                  <div className="connect-empty">
                    Canvas returned no courses where you hold a teacher, TA, or designer seat
                    on this instance. Check that your enrollment is active.
                  </div>
                ) : visible.length === 0 ? (
                  <div className="connect-empty">
                    No current courses here. {hidden} unpublished or ended{' '}
                    {hidden === 1 ? 'course is' : 'courses are'} under{' '}
                    <button type="button" className="link-button" onClick={() => setShowAll(true)}>
                      All courses
                    </button>
                    .
                  </div>
                ) : (
                  <ul className="course-grid" aria-label={`Courses on ${instance.host}`}>
                    {visible.map((course) => (
                      <li key={course.id}>
                        <CourseCard
                          course={course}
                          opening={opening?.host === instance.host && opening.id === course.id}
                          disabled={opening !== null}
                          onOpen={() => openCourse(instance.host, course.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </main>
        {footer}
      </div>
    );
  }

  return (
    <div className="connect">
      {nav}
      <main className="connect-card">
        {load.kind === 'loading' ? (
          <p className="connect-loading">Loading your Canvas courses…</p>
        ) : null}

        {load.kind === 'no_session' ? (
          <>
            <h1>Open the grader from Codex</h1>
            <p className="sub">{load.message}</p>
          </>
        ) : null}

        {load.kind === 'not_configured' ? (
          <>
            <h1>Connect your Canvas account</h1>
            <p className="sub">{load.message}</p>
            <div className="connect-help">
              In Canvas: open <strong>Account → Settings</strong>, choose{' '}
              <strong>+ New Access Token</strong>, and copy the token. Then put these two
              lines in <code>~/.aigrader/.env</code> and save:
              <ol>
                <li>
                  <code>CANVAS_BASE_URL=https://byui.instructure.com</code>
                </li>
                <li>
                  <code>CANVAS_API_TOKEN=</code> followed by the token you copied
                </li>
              </ol>
              Reload this page when you&apos;re done.
            </div>
          </>
        ) : null}

        {load.kind === 'error' ? (
          <>
            <h1>Something went wrong</h1>
            <p className="sub">{load.message}</p>
          </>
        ) : null}
      </main>
      {footer}
    </div>
  );
}
