'use client';

// The local course picker. The teacher's Canvas access comes from their own
// ~/.aigrader/.env (CANVAS_BASE_URL + CANVAS_API_TOKEN); this page lists the
// courses on each configured Canvas instance where Canvas says they are a
// teacher, TA, or designer, verifies the pick with Canvas, and opens
// /courses/{courseKey}.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import './connect.css';

interface CourseRow {
  id: number;
  name: string;
  courseCode: string | null;
  enrollmentRole: string;
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

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? 'Something went wrong. Try again.';
}

export default function CoursePickerPage() {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selected, setSelected] = useState<{ host: string; id: number } | null>(null);
  const [busy, setBusy] = useState(false);
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

  function openCourse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch('/api/canvas/courses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: selected.host, courseId: selected.id }),
        });
        if (!res.ok) {
          setError(await readError(res));
          return;
        }
        const { courseKey } = (await res.json()) as { courseKey: string };
        router.push(`/courses/${encodeURIComponent(courseKey)}`);
      } catch {
        setError('Could not reach the local grader. Is it still running?');
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className="connect">
      <nav className="connect-nav">
        <Link className="brand" href="/connect">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/aigrader-white-square.png" alt="" aria-hidden />
          <span>BYU-(A)I Grader</span>
        </Link>
      </nav>

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

        {load.kind === 'ready' ? (
          <>
            <h1>Pick a course to grade</h1>
            <p className="sub">
              Courses where Canvas lists you as a teacher, TA, or designer. Everything you
              approve here posts to Canvas under your own account.
            </p>
            <form onSubmit={openCourse}>
              {load.instances.map((instance) => (
                <section key={instance.host} className="connect-instance">
                  <h2>{instance.host}</h2>
                  {instance.canvasUserName ? (
                    <p className="connect-status">
                      Signed in to Canvas as <strong>{instance.canvasUserName}</strong>
                    </p>
                  ) : null}
                  {instance.error ? (
                    <div className="connect-empty">{instance.error}</div>
                  ) : instance.courses.length === 0 ? (
                    <div className="connect-empty">
                      Canvas returned no courses where you hold a teacher, TA, or designer
                      seat on this instance. Check that the course is published and your
                      enrollment is active.
                    </div>
                  ) : (
                    <div className="course-list" role="radiogroup" aria-label={`Courses on ${instance.host}`}>
                      {instance.courses.map((course) => {
                        const isSelected =
                          selected?.host === instance.host && selected.id === course.id;
                        return (
                          <label
                            key={course.id}
                            className={`course-option ${isSelected ? 'selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="course"
                              value={`${instance.host}#${course.id}`}
                              checked={isSelected}
                              onChange={() => setSelected({ host: instance.host, id: course.id })}
                            />
                            <span>
                              <span className="name">{course.name}</span>
                              <br />
                              <span className="meta">
                                {course.courseCode ? `${course.courseCode} · ` : ''}
                                {course.enrollmentRole}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}
              <button
                className="connect-submit"
                type="submit"
                disabled={busy || selected === null}
                style={{ width: '100%' }}
              >
                {busy ? 'Checking your enrollment…' : 'Open this course'}
              </button>
            </form>
          </>
        ) : null}

        {error ? (
          <p className="connect-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
      <p className="connect-footer">BYU-Idaho · Instructional Technology</p>
    </div>
  );
}
