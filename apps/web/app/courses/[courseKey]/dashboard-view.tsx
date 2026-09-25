'use client';

// Ported from: C:\Devs\AIgrader\app\lti\dashboard-view.tsx
// Faculty dashboard: hero, get-started steps, course pulse, alignment
// overview (stat grid + donut, fed by the alignment audit), assignments
// preview, recent runs. Data flows through the course-scoped
// /api/courses/[courseKey]/* routes (the in-process engine owns Canvas).

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { I } from './_components/icons';
import { Step, Dots, Stat, StatDonut, InfoBanner } from './_components/ui';

type AlignmentSummary = {
  method: string; // 'heuristic' | 'ai'
  outcomes: { found: number; aligned: number };
  rubrics: { found: number; aligned: number };
  alignmentScore: number;
  issues: unknown[];
};

type AssignmentRow = {
  id: number;
  name: string;
  bucket: 'ready_to_grade' | 'upcoming' | 'past';
  itemType: 'assignment' | 'discussion' | 'quiz';
  dueAt: string | null;
  pointsPossible: number | null;
  hasRubric: boolean;
  rubricCriteriaCount: number;
  needsGradingCount: number;
};

type RunRow = {
  runId: string;
  canvasAssignmentId: number;
  createdAt: string;
  filename: string;
};

function HeroIllo() {
  return (
    <svg width="220" height="160" viewBox="0 0 220 160" fill="none" aria-hidden>
      <defs>
        <radialGradient id="cloud" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0" stopColor="#F6EDCD" stopOpacity="0.9" />
          <stop offset="1" stopColor="#F6EDCD" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="135" cy="80" rx="80" ry="55" fill="url(#cloud)" />
      <rect x="78" y="28" width="78" height="100" rx="8" fill="#fff" stroke="#172145" strokeWidth="2.5" />
      <rect x="100" y="22" width="34" height="14" rx="3" fill="#172145" />
      <g stroke="#16A34A" strokeWidth="2" strokeLinecap="round" fill="none">
        <path d="M88 56l5 5 10-12" />
        <path d="M88 80l5 5 10-12" />
        <path d="M88 104l5 5 10-12" />
      </g>
      <rect x="110" y="56" width="38" height="4" rx="2" fill="#CBD5E1" />
      <rect x="110" y="80" width="38" height="4" rx="2" fill="#CBD5E1" />
      <rect x="110" y="104" width="30" height="4" rx="2" fill="#CBD5E1" />
      <circle cx="178" cy="110" r="26" fill="#fff" stroke="#172145" strokeWidth="2.5" />
      <g stroke="#C9A227" strokeWidth="3" strokeLinecap="round" fill="none">
        <line x1="168" y1="120" x2="168" y2="116" />
        <line x1="174" y1="120" x2="174" y2="110" />
        <line x1="180" y1="120" x2="180" y2="106" />
        <line x1="186" y1="120" x2="186" y2="100" />
      </g>
    </svg>
  );
}

export function DashboardView({
  courseKey,
  isStaff,
}: {
  courseKey: string;
  isStaff: boolean;
}) {
  const router = useRouter();
  const ck = encodeURIComponent(courseKey);
  const base = `/courses/${ck}`;

  const [assignments, setAssignments] = React.useState<AssignmentRow[]>([]);
  const [recentRuns, setRecentRuns] = React.useState<RunRow[]>([]);
  const [query, setQuery] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);
  const [alignment, setAlignment] = React.useState<AlignmentSummary | null>(null);
  const [reviewing, setReviewing] = React.useState(false);
  const [reviewError, setReviewError] = React.useState<string | null>(null);

  // Pull recent runs. Re-run on window focus so the dashboard reflects a run
  // the instructor just launched from Codex or another tab.
  const refreshLive = React.useCallback(async () => {
    const runsRes = await fetch(`/api/courses/${ck}/runs`)
      .then((r) => r.json())
      .catch(() => null);
    if (Array.isArray(runsRes?.runs)) {
      const runs = [...(runsRes.runs as RunRow[])].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      setRecentRuns(runs.slice(0, 5));
    }
  }, [ck]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [aRes, alRes] = await Promise.allSettled([
        fetch(`/api/courses/${ck}/assignments`).then((r) => r.json()),
        fetch(`/api/courses/${ck}/alignment`).then((r) => r.json()),
      ]);
      if (!cancelled && aRes.status === 'fulfilled' && Array.isArray(aRes.value?.assignments)) {
        setAssignments(aRes.value.assignments);
      }
      if (!cancelled && alRes.status === 'fulfilled' && alRes.value?.latest) {
        setAlignment(alRes.value.latest as AlignmentSummary);
      }
      await refreshLive();
      if (!cancelled) setLoaded(true);
    })();
    const onFocus = () => void refreshLive();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [ck, refreshLive]);

  // Full AI alignment review (the engine caps + fans out the model calls).
  const runAlignmentReview = React.useCallback(async () => {
    setReviewing(true);
    setReviewError(null);
    try {
      const res = await fetch(`/api/courses/${ck}/alignment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'ai' }),
      });
      const body = (await res.json().catch(() => null)) as
        | { latest?: AlignmentSummary; message?: string }
        | null;
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      if (body?.latest) setAlignment(body.latest);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Review failed.');
    } finally {
      setReviewing(false);
    }
  }, [ck]);

  const preview = assignments
    .filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 6);

  const assignmentName = React.useCallback(
    (id: number) => assignments.find((a) => a.id === id)?.name ?? `Assignment ${id}`,
    [assignments],
  );

  return (
    <div className="head-wrap">
      <div className="page-head">
        <div className="crumbs">
          <span>Dashboard</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 32 }}>
          <div>
            <h1 className="page-title">
              AI Grading Dashboard <I.Sparkle w={26} h={26} stroke="var(--blue-500)" />
            </h1>
            <p className="page-sub">
              BYU-(A)I Grader drafts the scores and feedback; you review
              every word before anything posts.
            </p>
          </div>
          <div style={{ marginTop: -16, flexShrink: 0 }}>
            <HeroIllo />
          </div>
        </div>
      </div>

      {!isStaff ? (
        <div style={{ marginBottom: 20 }}>
          <InfoBanner icon={<I.Warn w={18} h={18} />}>
            This tool is limited to course staff — grading actions are disabled for your role.
          </InfoBanner>
        </div>
      ) : null}

      {/* Get Started Steps */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 24,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Get Started in 3 Steps</h2>
          <button className="btn btn-primary" onClick={() => router.push(`${base}/assignments`)}>
            Select Assignment
          </button>
        </div>
        <div className="steps">
          <Step n="1" active title="Select Assignment" body="Choose an assignment to configure AI grading." />
          <Dots />
          <Step n="2" title="Create AI Profile" body="Define your grading lens, criteria, and feedback tone." />
          <Dots />
          <Step n="3" title="Review & Launch" body="Preview AI grading and launch when ready." />
        </div>
      </div>

      {/* Course pulse */}
      <div className="card">
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 16px' }}>Course Pulse</h2>
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <Stat
            icon={<I.Bars w={20} h={20} />}
            iconClass="blue"
            label="Waiting to grade"
            value={assignments.reduce((n, a) => n + (a.needsGradingCount ?? 0), 0)}
            meta="submissions across all assignments"
          />
          <Stat
            icon={<I.CheckCirc w={20} h={20} />}
            iconClass="green"
            label="Ready to grade"
            value={assignments.filter((a) => a.bucket === 'ready_to_grade').length}
            meta="assignments with work waiting"
          />
          <Stat
            icon={<I.Clock w={20} h={20} />}
            iconClass="amber"
            label="Upcoming"
            value={assignments.filter((a) => a.bucket === 'upcoming').length}
            meta="assignments not yet submitted to"
          />
        </div>
      </div>

      {/* Course Alignment Overview — fed by the M6 alignment audit */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <h2
            style={{
              fontSize: 18,
              fontWeight: 600,
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            Course Alignment Overview <I.Info w={16} h={16} stroke="var(--ink-400)" />
          </h2>
          <button
            className="btn btn-secondary"
            disabled={!isStaff || reviewing || !loaded}
            title={isStaff ? undefined : 'Alignment reviews are limited to course staff.'}
            onClick={() => void runAlignmentReview()}
          >
            <I.Refresh w={15} h={15} /> {reviewing ? 'Reviewing…' : 'Run Alignment Review'}
          </button>
        </div>
        <div className="stat-grid">
          <Stat
            icon={<I.Target />}
            iconClass="green"
            label="Learning Outcomes"
            value={alignment ? alignment.outcomes.found : '—'}
            meta="outcomes found"
          />
          <Stat
            icon={<I.Doc />}
            iconClass="blue"
            label="Rubrics"
            value={alignment ? alignment.rubrics.found : '—'}
            meta="rubrics found"
          />
          <StatDonut
            label="Alignment Score"
            value={alignment ? `${alignment.alignmentScore}%` : '—'}
            meta={
              alignment
                ? alignment.method === 'ai'
                  ? alignment.alignmentScore >= 80
                    ? 'Good Alignment'
                    : 'Review'
                  : 'Estimate'
                : 'Not yet scanned'
            }
            pct={alignment?.alignmentScore ?? 0}
          />
          <Stat
            icon={<I.Warn />}
            iconClass="amber"
            label="Issues to Review"
            value={alignment ? alignment.issues.length : '—'}
            meta="misalignments"
          />
        </div>
        <div style={{ marginTop: 18 }}>
          {reviewError ? (
            <InfoBanner icon={<I.Warn w={18} h={18} />}>{reviewError}</InfoBanner>
          ) : alignment?.method === 'ai' ? (
            <InfoBanner
              action={
                <Link className="btn btn-secondary" href={`${base}/outcomes`}>
                  Open Outcomes & Alignment <I.ArrowRight w={14} h={14} />
                </Link>
              }
            >
              Findings, recommendations, and the audit history live on the Outcomes &amp;
              Alignment page.
            </InfoBanner>
          ) : (
            <InfoBanner
              action={
                <Link className="btn btn-secondary" href={`${base}/outcomes`}>
                  Open Outcomes & Alignment <I.ArrowRight w={14} h={14} />
                </Link>
              }
            >
              These numbers are a quick structural estimate — run an alignment review to have the
              AI read your outcomes, rubrics, and instructions.
            </InfoBanner>
          )}
        </div>
      </div>

      {/* Assignments preview */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            gap: 16,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Assignments</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="input-with-icon" style={{ width: 280 }}>
              <I.Search w={16} h={16} />
              <input
                className="input"
                placeholder="Search assignments..."
                aria-label="Search assignments"
                style={{ paddingTop: 8, paddingBottom: 8 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="btn btn-secondary" onClick={() => router.push(`${base}/assignments`)}>
              View all <I.ArrowRight w={14} h={14} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {preview.length === 0 ? (
            <div style={{ padding: '24px 4px', color: 'var(--ink-500)', fontSize: 13.5 }}>
              {loaded ? 'No assignments found in this course.' : 'Loading assignments…'}
            </div>
          ) : (
            preview.map((a) => (
              <div
                key={a.id}
                className="row-card"
                onClick={() => router.push(`${base}/assignments/${a.id}/prepare`)}
              >
                <div>
                  <span
                    className={
                      'pill ' +
                      (a.itemType === 'quiz'
                        ? 'pill-quiz'
                        : a.itemType === 'discussion'
                          ? 'pill-programming'
                          : 'pill-assignment')
                    }
                  >
                    {a.itemType === 'quiz'
                      ? 'Quiz'
                      : a.itemType === 'discussion'
                        ? 'Discussion'
                        : 'Assignment'}
                  </span>
                  {a.bucket === 'ready_to_grade' ? (
                    <span className="pill pill-ready" style={{ marginLeft: 6 }}>
                      {a.needsGradingCount > 0 ? `${a.needsGradingCount} to grade` : 'Ready'}
                    </span>
                  ) : null}
                  <div className="title">{a.name}</div>
                  <div className="meta">
                    {a.pointsPossible != null ? `${a.pointsPossible} pts` : '—'}
                    {a.rubricCriteriaCount > 0 ? ` · ${a.rubricCriteriaCount}-criterion rubric` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '7px 16px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`${base}/assignments/${a.id}/prepare`);
                    }}
                  >
                    Grade
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recent grading runs — entry points into the review screen */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Recent grading runs</h2>
          <Link className="btn btn-secondary" href={`${base}/runs`}>
            View all <I.ArrowRight w={14} h={14} />
          </Link>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {recentRuns.length === 0 ? (
            <div style={{ padding: '12px 4px', color: 'var(--ink-500)', fontSize: 13.5 }}>
              No grading runs yet — pick an assignment above to start one.
            </div>
          ) : (
            recentRuns.map((r) => (
              <Link
                key={r.runId}
                href={`${base}/runs/${encodeURIComponent(r.runId)}`}
                className="row-card"
                style={{ textDecoration: 'none' }}
              >
                <div>
                  <div className="title">{assignmentName(r.canvasAssignmentId)}</div>
                  <div className="meta">
                    Started{' '}
                    {new Date(r.createdAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
                <span className="pill pill-assignment">Open</span>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
