'use client';

// Run history list (M4, new in this rewrite — the predecessors surfaced runs
// only from the dashboard). One row per stored run document; opening a run
// lands on the review screen, which offers Resume when the run was
// interrupted.

import * as React from 'react';
import Link from 'next/link';
import { I } from '../_components/icons';
import { PageHead, InfoBanner } from '../_components/ui';

type RunRow = {
  runId: string;
  canvasAssignmentId: number;
  createdAt: string;
  filename: string;
};

type AssignmentRow = { id: number; name: string };

export function RunsView({ courseKey }: { courseKey: string }) {
  const ck = encodeURIComponent(courseKey);
  const base = `/courses/${ck}`;

  const [runs, setRuns] = React.useState<RunRow[]>([]);
  const [assignments, setAssignments] = React.useState<AssignmentRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [runsRes, aRes] = await Promise.allSettled([
        fetch(`/api/courses/${ck}/runs`).then(async (r) => ({ ok: r.ok, body: await r.json() })),
        fetch(`/api/courses/${ck}/assignments`).then((r) => r.json()),
      ]);
      if (cancelled) return;
      if (runsRes.status === 'fulfilled') {
        if (!runsRes.value.ok) {
          setError(runsRes.value.body?.message ?? 'Could not load runs.');
        } else if (Array.isArray(runsRes.value.body?.runs)) {
          const rows = [...(runsRes.value.body.runs as RunRow[])].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          );
          setRuns(rows);
        }
      }
      if (aRes.status === 'fulfilled' && Array.isArray(aRes.value?.assignments)) {
        setAssignments(aRes.value.assignments);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [ck]);

  const nameOf = (id: number) =>
    assignments.find((a) => a.id === id)?.name ?? `Assignment ${id}`;

  return (
    <div className="head-wrap">
      <PageHead
        crumbs={[{ label: 'Dashboard', href: base }, { label: 'Grading Runs' }]}
        title="Grading Runs"
        sparkle
        sub="Every AI grading run stored for this course. Open a run to keep reviewing, resume an interrupted run, or check what posted."
      />

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <InfoBanner icon={<I.Warn w={18} h={18} />}>{error}</InfoBanner>
        </div>
      ) : null}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Started</th>
              <th>Run ID</th>
              <th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId}>
                <td style={{ fontWeight: 600, fontSize: 14 }}>{nameOf(r.canvasAssignmentId)}</td>
                <td style={{ fontSize: 13.5 }}>
                  {new Date(r.createdAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </td>
                <td style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>
                  <code>{r.runId.slice(0, 12)}…</code>
                </td>
                <td style={{ textAlign: 'right', paddingRight: 24 }}>
                  <Link
                    className="btn btn-secondary"
                    style={{ padding: '7px 18px' }}
                    href={`${base}/runs/${encodeURIComponent(r.runId)}`}
                  >
                    Open / Resume <I.ArrowRight w={14} h={14} />
                  </Link>
                </td>
              </tr>
            ))}
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
              ? runs.length === 0
                ? 'No grading runs stored for this course yet.'
                : `${runs.length} run${runs.length === 1 ? '' : 's'}`
              : 'Loading runs…'}
          </div>
        </div>
      </div>
    </div>
  );
}
