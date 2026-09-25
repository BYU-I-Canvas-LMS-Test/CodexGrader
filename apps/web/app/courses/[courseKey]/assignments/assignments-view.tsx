'use client';

// Ported from: C:\Devs\AIgrader\app\lti\assignments\assignments-view.tsx
// Assignments list: summary stats, search + type/bucket filters, and the
// engine-sorted table (ready_to_grade → upcoming → past, assignment-board
// ordering within each bucket); rows come from
// /api/courses/[courseKey]/assignments.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { I } from '../_components/icons';
import { PageHead, BigStat } from '../_components/ui';

type AssignmentRow = {
  id: number;
  name: string;
  bucket: 'ready_to_grade' | 'upcoming' | 'past';
  itemType: 'assignment' | 'discussion' | 'quiz';
  dueAt: string | null;
  pointsPossible: number | null;
  hasRubric: boolean;
  rubricCriteriaCount: number;
  published: boolean;
  needsGradingCount: number;
  hasSubmissions: boolean;
};

const BUCKET_LABEL: Record<AssignmentRow['bucket'], { label: string; cls: string }> = {
  ready_to_grade: { label: 'Ready to grade', cls: 'pill-ready' },
  upcoming: { label: 'Upcoming', cls: 'pill-notready' },
  past: { label: 'Past', cls: 'pill-auto' },
};

function kindPill(kind: AssignmentRow['itemType']): { label: string; cls: string } {
  if (kind === 'quiz') return { label: 'Quiz', cls: 'pill-quiz' };
  if (kind === 'discussion') return { label: 'Discussion', cls: 'pill-programming' };
  return { label: 'Assignment', cls: 'pill-assignment' };
}

function formatDue(iso: string | null): { date: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  };
}

export function AssignmentsView({ courseKey }: { courseKey: string }) {
  const router = useRouter();
  const ck = encodeURIComponent(courseKey);
  const base = `/courses/${ck}`;

  const [rows, setRows] = React.useState<AssignmentRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [query, setQuery] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState('all');
  const [bucketFilter, setBucketFilter] = React.useState('all');

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/courses/${ck}/assignments`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.message ?? 'Could not load assignments.');
        } else if (Array.isArray(body?.assignments)) {
          setRows(body.assignments);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ck]);

  const filtered = rows.filter((r) => {
    if (query && !r.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (typeFilter !== 'all' && r.itemType !== typeFilter) return false;
    if (bucketFilter !== 'all' && r.bucket !== bucketFilter) return false;
    return true;
  });

  const total = rows.length;
  const ready = rows.filter((r) => r.bucket === 'ready_to_grade').length;
  const upcoming = rows.filter((r) => r.bucket === 'upcoming').length;
  const quizzes = rows.filter((r) => r.itemType === 'quiz').length;

  return (
    <div className="head-wrap">
      <PageHead
        crumbs={[{ label: 'Dashboard', href: base }, { label: 'Assignments' }]}
        title="Assignments"
        sparkle
        sub="Select an assignment to prepare AI grading and launch a run."
      />

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          <BigStat icon={<I.Doc w={22} h={22} />} iconClass="blue" value={total} label="Total Assignments" sub="In this course" />
          <BigStat icon={<I.CheckCirc w={22} h={22} />} iconClass="green" value={ready} label="Ready to Grade" sub="Submissions waiting" />
          <BigStat icon={<I.Clock w={22} h={22} />} iconClass="amber" value={upcoming} label="Upcoming" sub="No submissions yet" />
          <BigStat icon={<I.Help w={22} h={22} />} iconClass="purple" value={quizzes} label="Quizzes" sub="Essay grading supported" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 20, marginBottom: 12 }}>
        <div className="input-with-icon" style={{ flex: 1, maxWidth: 380 }}>
          <I.Search w={16} h={16} />
          <input
            className="input"
            placeholder="Search assignments..."
            aria-label="Search assignments"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="select"
          style={{ width: 160 }}
          value={typeFilter}
          aria-label="Filter by type"
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="all">All Types</option>
          <option value="assignment">Assignment</option>
          <option value="quiz">Quiz</option>
          <option value="discussion">Discussion</option>
        </select>
        <select
          className="select"
          style={{ width: 180 }}
          value={bucketFilter}
          aria-label="Filter by status"
          onChange={(e) => setBucketFilter(e.target.value)}
        >
          <option value="all">All Statuses</option>
          <option value="ready_to_grade">Ready to grade</option>
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
        </select>
        <div style={{ flex: 1 }} />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Type</th>
              <th>Points</th>
              <th>Submissions</th>
              <th>Due Date</th>
              <th>Status</th>
              <th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const due = formatDue(r.dueAt);
              const kp = kindPill(r.itemType);
              const bp = BUCKET_LABEL[r.bucket];
              return (
                <tr
                  key={r.id}
                  className={selectedId === r.id ? 'selected' : ''}
                  onClick={() => setSelectedId(r.id)}
                >
                  <td>
                    <span className={'pill ' + kp.cls}>{kp.label}</span>
                    <div style={{ fontWeight: 600, fontSize: 14, marginTop: 6 }}>{r.name}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 2 }}>
                      {r.rubricCriteriaCount > 0
                        ? `${r.rubricCriteriaCount}-criterion rubric`
                        : 'No rubric attached'}
                      {!r.published ? ' · unpublished' : ''}
                    </div>
                  </td>
                  <td>
                    <span className={'pill ' + kp.cls}>{kp.label}</span>
                  </td>
                  <td style={{ fontWeight: 500 }}>{r.pointsPossible ?? '—'}</td>
                  <td style={{ minWidth: 140, fontSize: 13 }}>
                    {r.needsGradingCount > 0 ? (
                      <span>{r.needsGradingCount} need grading</span>
                    ) : r.hasSubmissions ? (
                      <span>Has submissions</span>
                    ) : (
                      <span style={{ color: 'var(--ink-500)' }}>No submissions</span>
                    )}
                  </td>
                  <td style={{ fontSize: 13.5 }}>
                    {due ? (
                      <>
                        <div>{due.date}</div>
                        <div style={{ fontSize: 12, color: 'var(--ink-500)' }}>{due.time}</div>
                      </>
                    ) : (
                      <span style={{ color: 'var(--ink-400)' }}>No due date</span>
                    )}
                  </td>
                  <td>
                    <span className={'pill ' + bp.cls}>{bp.label}</span>
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: 24 }}>
                    <button
                      className="btn btn-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`${base}/assignments/${r.id}/prepare`);
                      }}
                      style={{ padding: '7px 18px' }}
                    >
                      Grade
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '14px 20px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <div style={{ color: 'var(--ink-500)', fontSize: 13 }}>
            {loaded
              ? error ?? `Showing ${filtered.length} of ${total} assignments`
              : 'Loading assignments…'}
          </div>
        </div>
      </div>
    </div>
  );
}
