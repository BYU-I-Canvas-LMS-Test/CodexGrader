'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Pages\
// OutcomesAlignment.razor (feature set: heuristic/AI audit, findings,
// recommendations, per-assignment table, audit history, outcome manager +
// account library browser, rubric editor) with markup lifted from the TS
// predecessor's app\lti\outcomes\outcomes-view.tsx where the two match.
// Folded into THREE tabs for this app: "Alignment Audit" (overview stats,
// per-assignment statuses, findings, recommendations, history), "Outcomes"
// (course list, library browsing, link/unlink/create), and "Rubrics" (rubric
// findings + the in-app rubric editor the C# page hosted on its Rubrics tab).
//
// All data flows through /api/courses/[courseKey]/alignment* and
// /api/courses/[courseKey]/rubric routes — the in-process engine owns
// Canvas and the model calls.

import * as React from 'react';
import { I } from '../_components/icons';
import { PageHead, Donut, ErrorBanner, InfoBanner } from '../_components/ui';
import {
  newCriterion,
  newRating,
  sharedWarning,
  stripHtmlText,
  toEditState,
  toUpdateCriteria,
  validateRubricEdit,
  type CriterionEdit,
  type RubricDto,
} from './rubric-edit';

// ------------------------------------------------------------------- types --

type Pairing = 'rubric_outcome' | 'rubric_instructions' | 'outcome_instructions';
type Severity = 'high' | 'medium' | 'low';

type Issue = {
  severity: string;
  assignment: string;
  pairing: string;
  title: string;
  detail: string;
  suggestion: string;
};

type AssignmentStatus = {
  canvasAssignmentId: number;
  assignmentName: string;
  status: string; // 'reviewed' | 'error' | 'skipped'
  alignmentScore: number | null;
  summary: string | null;
};

type Report = {
  method: string; // 'heuristic' | 'ai'
  scannedAt: string;
  outcomes: { found: number; aligned: number };
  rubrics: { found: number; aligned: number };
  assignmentsScanned: number;
  reviewed: number;
  assignments: AssignmentStatus[];
  scanErrors: { assignment: string; message: string }[];
  alignmentScore: number;
  issues: Issue[];
};

type HistoryRow = {
  scannedAt: string;
  method: string;
  alignmentScore: number;
  issueCount: number;
  highSeverityCount: number;
};

type Outcome = { id: number; title: string; description: string };

type AssignmentRow = {
  id: number;
  name: string;
  itemType: 'assignment' | 'discussion' | 'quiz';
  rubricCriteriaCount: number;
};

const SEVERITY_META: Record<Severity, { label: string; circ: string; pill: string }> = {
  high: { label: 'High', circ: 'amber', pill: 'tag-amber' },
  medium: { label: 'Medium', circ: 'blue', pill: 'tag-blue' },
  low: { label: 'Low', circ: 'blue', pill: 'tag-blue' },
};

function severityMeta(severity: string) {
  return severity === 'high' || severity === 'medium' || severity === 'low'
    ? SEVERITY_META[severity]
    : SEVERITY_META.low;
}

function severityRank(severity: string): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

function pairingLabel(pairing: string): string {
  switch (pairing as Pairing) {
    case 'rubric_outcome':
      return 'Rubric ↔ Outcomes';
    case 'rubric_instructions':
      return 'Rubric ↔ Instructions';
    case 'outcome_instructions':
      return 'Outcomes ↔ Instructions';
    default:
      return pairing;
  }
}

function scoreColor(score: number): string {
  return score >= 80 ? 'var(--green-600)' : score >= 50 ? 'var(--amber-600)' : 'var(--red-600)';
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// -------------------------------------------------------------------- view --

const TABS = [
  ['alignment', 'Alignment Audit'],
  ['outcomes', 'Outcomes'],
  ['rubrics', 'Rubrics'],
] as const;

export function OutcomesView({ courseKey, isStaff }: { courseKey: string; isStaff: boolean }) {
  const ck = encodeURIComponent(courseKey);
  const base = `/courses/${ck}`;

  const [tab, setTab] = React.useState<string>('alignment');
  const [ready, setReady] = React.useState(false);
  const [reviewing, setReviewing] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<Report | null>(null);
  const [history, setHistory] = React.useState<HistoryRow[]>([]);
  const [outcomes, setOutcomes] = React.useState<Outcome[]>([]);
  const [rows, setRows] = React.useState<AssignmentRow[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [al, asg, out] = await Promise.allSettled([
        fetch(`/api/courses/${ck}/alignment`).then((r) => r.json()),
        fetch(`/api/courses/${ck}/assignments`).then((r) => r.json()),
        fetch(`/api/courses/${ck}/alignment/outcomes?list=course`).then((r) => r.json()),
      ]);
      if (cancelled) return;
      if (al.status === 'fulfilled' && al.value?.latest) {
        setReport(al.value.latest as Report);
        if (Array.isArray(al.value.history)) setHistory(al.value.history as HistoryRow[]);
      } else if (al.status === 'rejected') {
        setLoadError('Could not load the alignment audit.');
      }
      if (asg.status === 'fulfilled' && Array.isArray(asg.value?.assignments)) {
        setRows(asg.value.assignments as AssignmentRow[]);
      }
      if (out.status === 'fulfilled' && Array.isArray(out.value?.outcomes)) {
        setOutcomes(out.value.outcomes as Outcome[]);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [ck]);

  async function runReview() {
    setReviewing(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/courses/${ck}/alignment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'ai' }),
      });
      const body = (await res.json().catch(() => null)) as
        | { latest?: Report; history?: HistoryRow[] | null; message?: string }
        | null;
      if (!res.ok) {
        throw new Error(`Review failed: ${body?.message ?? `HTTP ${res.status}`}`);
      }
      if (body?.latest) setReport(body.latest);
      if (Array.isArray(body?.history)) setHistory(body.history);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Review failed.');
    } finally {
      setReviewing(false);
    }
  }

  const score = report?.alignmentScore ?? 0;
  const issues = report?.issues ?? [];
  const scanErrors = report?.scanErrors ?? [];
  const hasAiReport = report?.method === 'ai';
  // Findings route to sections by which artifacts they concern: a
  // rubric↔outcome finding is relevant to BOTH outcomes and rubrics.
  const outcomeFindings = issues.filter(
    (i) => i.pairing === 'rubric_outcome' || i.pairing === 'outcome_instructions',
  );
  const rubricFindings = issues.filter(
    (i) => i.pairing === 'rubric_outcome' || i.pairing === 'rubric_instructions',
  );
  const scannedLabel = report ? whenLabel(report.scannedAt) : '—';

  const statusOf = (row: AssignmentRow): { label: string; cls: string } => {
    const entry = report?.assignments.find((a) => a.canvasAssignmentId === row.id);
    if (scanErrors.some((e) => e.assignment === row.name)) {
      return { label: 'Could not review', cls: 'pill-review' };
    }
    if (entry?.status === 'reviewed') return { label: 'Reviewed', cls: 'pill-good' };
    return { label: 'Not yet reviewed', cls: 'pill-notready' };
  };
  const scoreOf = (assignmentId: number): number | null =>
    report?.assignments.find((a) => a.canvasAssignmentId === assignmentId)?.alignmentScore ?? null;

  const jumpTo = (id: string) => {
    setTab('alignment');
    // After a tab switch the section may not be mounted yet.
    window.setTimeout(
      () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  };

  return (
    <div className="head-wrap">
      <PageHead
        crumbs={[{ label: 'Dashboard', href: base }, { label: 'Outcomes & Alignment' }]}
        title="Outcomes & Rubric Alignment"
        sparkle
        sub="We scanned your course for outcomes, rubrics, and assignment instructions to evaluate alignment and identify areas to review."
        action={
          <button
            className="btn btn-primary"
            style={{ flexShrink: 0 }}
            onClick={runReview}
            disabled={!isStaff || reviewing || !ready}
            title={isStaff ? undefined : 'Alignment reviews are limited to course staff.'}
          >
            <I.Refresh w={15} h={15} /> {reviewing ? 'Reviewing…' : 'Run Alignment Review'}
          </button>
        }
      />

      {loadError ? (
        <div style={{ marginBottom: 20 }}>
          <ErrorBanner>{loadError}</ErrorBanner>
        </div>
      ) : null}

      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--border)',
            marginBottom: 24,
          }}
        >
          <div className="o-tabs">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                className={'sg-tab ' + (tab === id ? 'active' : '')}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--ink-500)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingBottom: 12,
            }}
          >
            Last scanned: {scannedLabel}
            <I.Refresh w={13} h={13} stroke="var(--ink-400)" />
          </div>
        </div>

        {!ready ? (
          <div style={{ padding: '24px 4px', color: 'var(--ink-500)', fontSize: 13.5 }}>
            Loading alignment data…
          </div>
        ) : tab === 'alignment' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
            <OutcomeStat
              icon={<I.Target w={20} h={20} />}
              iconClass="green"
              value={outcomes.length}
              label="Learning Outcomes"
              meta="Linked from Canvas"
              extra={
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12.5, fontWeight: 500, padding: 0 }}
                  onClick={() => setTab('outcomes')}
                >
                  Manage outcomes →
                </button>
              }
            />
            <OutcomeStat
              icon={<I.Doc w={20} h={20} />}
              iconClass="blue"
              value={report?.rubrics.found ?? 0}
              label="Rubrics"
              meta="Found in course"
              extra={
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12.5, fontWeight: 500, padding: 0 }}
                  onClick={() => setTab('rubrics')}
                >
                  Review rubrics →
                </button>
              }
            />
            <div className="stat" style={{ padding: 16 }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <Donut pct={score} size={64} stroke={7} />
                <div>
                  <div className="stat-label">Alignment Score</div>
                  <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>
                    {score}%
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--green-600)', fontWeight: 600 }}>
                    {score >= 80 ? 'Good Alignment' : 'Review'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-500)' }}>
                    Overall · {hasAiReport ? 'AI review' : 'estimate'}
                  </div>
                </div>
              </div>
            </div>
            <OutcomeStat
              icon={<I.Warn w={20} h={20} />}
              iconClass="amber"
              value={issues.length}
              label="Issues to Review"
              meta="Across the course"
              extra={
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12.5, fontWeight: 500, padding: 0 }}
                  onClick={() => jumpTo('alignment-recs')}
                >
                  See recommendations →
                </button>
              }
            />
            <OutcomeStat
              icon={<I.Doc w={20} h={20} />}
              iconClass="purple"
              value={hasAiReport ? `${report?.reviewed ?? 0}/${report?.assignmentsScanned ?? 0}` : '—'}
              label="Assignments Reviewed"
              meta="Completed / attempted"
              extra={
                !hasAiReport ? (
                  <span style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>Not yet reviewed</span>
                ) : scanErrors.length > 0 ? (
                  <span style={{ fontSize: 12.5, color: 'var(--amber-600)' }}>
                    {scanErrors.length} could not be reviewed
                  </span>
                ) : (
                  <span
                    style={{
                      display: 'flex',
                      gap: 4,
                      alignItems: 'center',
                      fontSize: 12.5,
                      color: 'var(--ink-500)',
                    }}
                  >
                    all reviewed <I.CheckCirc w={13} h={13} stroke="var(--green-500)" />
                  </span>
                )
              }
            />
          </div>
        ) : tab === 'outcomes' ? (
          <OutcomesManager
            ck={ck}
            isStaff={isStaff}
            outcomes={outcomes}
            onChange={setOutcomes}
          />
        ) : null}
      </div>

      {ready && tab === 'alignment' && (
        <>
          {scanErrors.length > 0 && (
            <div className="card" style={{ marginTop: 20, border: '1px solid #FCD34D' }}>
              <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <I.Warn w={16} h={16} stroke="var(--amber-600)" /> {scanErrors.length} assignment
                {scanErrors.length === 1 ? '' : 's'} could not be reviewed
              </div>
              <ul style={{ margin: '8px 0 0 22px', fontSize: 13, color: 'var(--ink-600)', lineHeight: 1.6 }}>
                {scanErrors.map((e, i) => (
                  <li key={i}>
                    <strong>{e.assignment}</strong>: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card" style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 6px' }}>Review top-down</h2>
            <p style={{ margin: '0 0 16px', color: 'var(--ink-500)', fontSize: 13.5 }}>
              Alignment flows from the top down. Start with your outcomes, then your rubrics, then
              each assignment&apos;s instructions — fixing the top removes problems below. Some
              issues span two layers (a rubric-to-outcome gap shows under both Outcomes and
              Rubrics), so the per-section counts can add up to more than the unique total.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <GuideCard
                n="1"
                title="Outcomes"
                body="Confirm the course outcomes are the ones you actually teach."
                count={outcomeFindings.length}
                onClick={() => setTab('outcomes')}
              />
              <GuideCard
                n="2"
                title="Rubrics"
                body="Make sure each rubric measures those outcomes."
                count={rubricFindings.length}
                onClick={() => setTab('rubrics')}
              />
              <GuideCard
                n="3"
                title="Assignments"
                body="Check each assignment's instructions ask for what the rubric grades."
                onClick={() => jumpTo('alignment-details')}
              />
            </div>
          </div>

          <div className="card" style={{ marginTop: 20 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Alignment by Assignment</h2>
            <p style={{ margin: '6px 0 16px', color: 'var(--ink-500)', fontSize: 13.5 }}>
              See how well each assignment&apos;s instructions and rubric align with course outcomes.
            </p>
            <table className="o-tbl">
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Rubric Criteria</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((r) => {
                  const hasRubric = r.rubricCriteriaCount > 0;
                  const rs = statusOf(r);
                  const rowScore = scoreOf(r.id);
                  return (
                    <tr key={r.id}>
                      <td>
                        <span className={'pill ' + (r.itemType === 'quiz' ? 'pill-quiz' : 'pill-assignment')}>
                          {r.itemType === 'quiz' ? 'Quiz' : 'Assignment'}
                        </span>
                        <span style={{ marginLeft: 10, fontWeight: 500 }}>{r.name}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>{r.rubricCriteriaCount}</td>
                      <td>
                        <span className={'pill ' + (hasRubric ? 'pill-good' : 'pill-review')}>
                          {hasRubric ? 'Has rubric' : 'Needs rubric'}
                        </span>
                      </td>
                      <td>
                        {rowScore != null ? (
                          <strong style={{ color: scoreColor(rowScore) }}>{rowScore}%</strong>
                        ) : (
                          <span style={{ color: 'var(--ink-400)' }}>—</span>
                        )}
                      </td>
                      <td>
                        <span className={'pill ' + rs.cls}>{rs.label}</span>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ color: 'var(--ink-500)' }}>
                      No assignments found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginTop: 20 }} id="alignment-rubric-findings">
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Outcome & Rubric Findings</h2>
            <p style={{ margin: '6px 0 16px', color: 'var(--ink-500)', fontSize: 13.5 }}>
              Are your course outcomes actually assessed by a rubric, is each criterion grounded in
              the assignment instructions, and do the instructions reflect the outcomes?
            </p>
            {issues.length === 0 ? (
              <div style={{ fontSize: 13.5, color: 'var(--ink-500)' }}>
                {hasAiReport
                  ? 'No issues here — these artifacts look aligned.'
                  : 'Run “Run Alignment Review” at the top to populate this section.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {issues.map((f, i) => (
                  <FindingCard key={i} f={f} />
                ))}
              </div>
            )}
          </div>

          <div id="alignment-details">
            {issues.length > 0 && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {[...groupByAssignment(issues).entries()].map(([name, fs]) => (
                  <div className="card" key={name}>
                    <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>{name}</h2>
                    <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--ink-500)' }}>
                      {fs.length} finding{fs.length === 1 ? '' : 's'}
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {fs.map((f, i) => (
                        <FindingCard key={i} f={f} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 20 }} id="alignment-recs">
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Recommendations</h2>
            <p style={{ margin: '6px 0 16px', color: 'var(--ink-500)', fontSize: 13.5 }}>
              A prioritized to-do list — work the high-severity items first. Each maps back to a
              specific assignment and the pairing it concerns.
            </p>
            {issues.length === 0 ? (
              <div style={{ fontSize: 13.5, color: 'var(--ink-500)' }}>
                {hasAiReport
                  ? 'Nothing to recommend — your outcomes, rubrics, and instructions are aligned.'
                  : 'Run “Run Alignment Review” at the top to get a prioritized to-do list.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[...issues]
                  .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
                  .map((f, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        padding: '12px 0',
                        borderBottom: '1px solid var(--ink-100)',
                      }}
                    >
                      <span className={'pill ' + severityMeta(f.severity).pill} style={{ flexShrink: 0 }}>
                        {severityMeta(f.severity).label}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13.5, color: 'var(--ink-800)' }}>{f.suggestion}</div>
                        <div style={{ fontSize: 12, color: 'var(--ink-400)', marginTop: 2 }}>
                          {f.assignment} · {pairingLabel(f.pairing)}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {history.length > 0 && (
            <div className="card" style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Audit history</h2>
                <span style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>score over time</span>
              </div>
              <table className="o-tbl">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Method</th>
                    <th>Score</th>
                    <th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i}>
                      <td>{whenLabel(h.scannedAt)}</td>
                      <td>{h.method}</td>
                      <td>
                        <strong style={{ color: scoreColor(h.alignmentScore) }}>{h.alignmentScore}</strong>
                      </td>
                      <td>
                        {h.issueCount} ({h.highSeverityCount} high)
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {ready && tab === 'rubrics' && (
        <RubricsTab
          ck={ck}
          isStaff={isStaff}
          outcomes={outcomes}
          rows={rows}
          findings={rubricFindings}
          hasAiReport={hasAiReport}
        />
      )}
    </div>
  );
}

function groupByAssignment(issues: Issue[]): Map<string, Issue[]> {
  const groups = new Map<string, Issue[]>();
  for (const f of issues) {
    const arr = groups.get(f.assignment) ?? [];
    arr.push(f);
    groups.set(f.assignment, arr);
  }
  return groups;
}

// ---- Overview stat tile (port of the TS OutStat) ----

function OutcomeStat({
  icon,
  iconClass,
  value,
  label,
  meta,
  extra,
}: {
  icon: React.ReactNode;
  iconClass: string;
  value: React.ReactNode;
  label: string;
  meta: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="stat" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div className={'icon-circ ' + iconClass}>{icon}</div>
      </div>
      <div className="stat-label" style={{ marginTop: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1, margin: '4px 0 2px' }}>
        {value}
      </div>
      <div className="stat-meta">{meta}</div>
      {extra ? <div style={{ marginTop: 6 }}>{extra}</div> : null}
    </div>
  );
}

// ---- Top-down guide + findings rendering (lifted from the TS view) ----

function GuideCard({
  n,
  title,
  body,
  count,
  onClick,
}: {
  n: string;
  title: string;
  body: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 16,
        background: 'var(--card-bg, #fff)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="step-num active" style={{ width: 28, height: 28, fontSize: 13 }}>
          {n}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{title}</span>
        {typeof count === 'number' && count > 0 ? (
          <span className="pill tag-amber" style={{ marginLeft: 'auto' }}>
            {count} to review
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-500)', lineHeight: 1.5 }}>{body}</div>
    </button>
  );
}

function FindingCard({ f }: { f: Issue }) {
  const meta = severityMeta(f.severity);
  return (
    <div className="issue-row" style={{ alignItems: 'flex-start', cursor: 'default' }}>
      <div className={'icon-circ ' + meta.circ} style={{ width: 36, height: 36, flexShrink: 0 }}>
        {f.severity === 'high' ? <I.Warn w={18} h={18} /> : <I.Info w={18} h={18} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{f.title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 2, lineHeight: 1.5 }}>
          {f.detail}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--ink-700)',
            marginTop: 6,
            display: 'flex',
            gap: 6,
            alignItems: 'flex-start',
          }}
        >
          <I.ArrowRight w={13} h={13} stroke="var(--blue-500)" />
          <span>
            <strong>Suggestion:</strong> {f.suggestion}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-400)', marginTop: 6 }}>{f.assignment}</div>
      </div>
      <span className={'pill ' + meta.pill} style={{ flexShrink: 0 }}>
        {pairingLabel(f.pairing)}
      </span>
    </div>
  );
}

// ---- Rubrics tab (port of the C# TabRubrics: findings + rubric editor) ----

function RubricsTab({
  ck,
  isStaff,
  outcomes,
  rows,
  findings,
  hasAiReport,
}: {
  ck: string;
  isStaff: boolean;
  outcomes: Outcome[];
  rows: AssignmentRow[];
  findings: Issue[];
  hasAiReport: boolean;
}) {
  return (
    <>
      <div className="card" style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Rubric Alignment</h2>
        <p style={{ margin: '6px 0 16px', color: 'var(--ink-500)', fontSize: 13.5 }}>
          Does each rubric criterion measure a stated outcome, and is every criterion grounded in
          the assignment instructions? Findings that involve a rubric appear here.
        </p>
        {findings.length === 0 ? (
          <div style={{ fontSize: 13.5, color: 'var(--ink-500)' }}>
            {hasAiReport
              ? 'No issues here — these artifacts look aligned.'
              : 'Run “Run Alignment Review” at the top to populate this tab.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {findings.map((f, i) => (
              <FindingCard key={i} f={f} />
            ))}
          </div>
        )}
      </div>

      <RubricEditorCard ck={ck} isStaff={isStaff} outcomes={outcomes} rows={rows} />
    </>
  );
}

// ---- Rubric editor (port of OutcomesAlignment.razor's Rubric Editor card,
// itself the port of assignment-view.tsx RubricEditorCard) ----

/** C# "0.#" point formatting: whole numbers bare, otherwise one decimal. */
function fmtPts(points: number): string {
  return String(Math.round(points * 10) / 10);
}

function RubricEditorCard({
  ck,
  isStaff,
  outcomes,
  rows,
}: {
  ck: string;
  isStaff: boolean;
  outcomes: Outcome[];
  rows: AssignmentRow[];
}) {
  const [assignmentId, setAssignmentId] = React.useState(0);
  const [rubric, setRubric] = React.useState<RubricDto | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editCriteria, setEditCriteria] = React.useState<CriterionEdit[]>([]);

  const loadRubric = React.useCallback(
    async (id: number): Promise<RubricDto | null> => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/courses/${ck}/rubric?assignmentId=${id}`);
        const body = (await res.json().catch(() => null)) as
          | { rubric?: RubricDto; message?: string; error?: string }
          | null;
        if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        const loaded = body?.rubric ?? null;
        setRubric(loaded);
        return loaded;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the rubric.');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [ck],
  );

  async function onAssignmentChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = Number(e.target.value) || 0;
    setEditing(false);
    setError(null);
    setRubric(null);
    setSaved(false);
    setAssignmentId(id);
    if (id === 0) return;
    await loadRubric(id);
  }

  async function startEdit() {
    // Re-fetch right before editing (the C# StartRubricEditAsync) so the form
    // opens on Canvas's CURRENT criteria with their exact ids.
    const fresh = await loadRubric(assignmentId);
    if (!fresh?.hasRubric) return;
    const state = toEditState(fresh);
    setEditTitle(state.title);
    setEditCriteria(state.criteria);
    setEditing(true);
    setSaved(false);
    setError(null);
  }

  const patchCriterion = (idx: number, patch: Partial<CriterionEdit>) =>
    setEditCriteria((cs) => cs.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  const patchRating = (ci: number, ri: number, patch: { description?: string; points?: number }) =>
    setEditCriteria((cs) =>
      cs.map((c, i) =>
        i === ci
          ? { ...c, ratings: c.ratings.map((r, j) => (j === ri ? { ...r, ...patch } : r)) }
          : c,
      ),
    );

  async function save() {
    if (!rubric) return;
    const invalid = validateRubricEdit(editCriteria);
    if (invalid) {
      setError(invalid);
      return;
    }
    // Shared rubrics change every associated assignment — confirm first (C#).
    if (rubric.shared && !window.confirm(`${sharedWarning(rubric)} Continue?`)) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${ck}/rubric`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignmentId,
          rubricId: rubric.rubricId,
          title: editTitle.trim() || rubric.title,
          // Ids pass through EXACTLY as loaded; empty ids (new rows) are
          // omitted by the form builder so Canvas mints fresh ones.
          criteria: toUpdateCriteria(editCriteria),
          rubricAssociationId: rubric.rubricAssociationId,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { rubric?: RubricDto; message?: string; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      // The engine re-fetched after the PUT — render what Canvas stored.
      if (body?.rubric) setRubric(body.rubric);
      setEditing(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const warning = rubric ? sharedWarning(rubric) : null;

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Rubric Editor</h2>
        {rubric?.hasRubric && !editing ? (
          <button
            className="btn-ghost"
            style={{ fontSize: 13, fontWeight: 500 }}
            onClick={startEdit}
            disabled={loading || !isStaff}
            title={isStaff ? undefined : 'Rubric changes are limited to course staff.'}
          >
            Edit rubric
          </button>
        ) : null}
      </div>
      <p style={{ margin: '0 0 14px', color: 'var(--ink-500)', fontSize: 13.5 }}>
        Pick an assignment to view its rubric, edit criteria and points, link criteria to course
        outcomes, and save back to Canvas.
      </p>

      <select
        className="select"
        style={{ maxWidth: 460 }}
        value={assignmentId === 0 ? '' : String(assignmentId)}
        onChange={onAssignmentChange}
      >
        <option value="">— Select an assignment —</option>
        {rows.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.rubricCriteriaCount > 0 ? '' : ' (no rubric)'}
          </option>
        ))}
      </select>

      {error ? <div style={{ color: 'var(--red-600)', fontSize: 13, marginTop: 12 }}>{error}</div> : null}
      {saved && !editing ? (
        <div style={{ color: 'var(--green-600)', fontSize: 13, marginTop: 12 }}>Saved to Canvas.</div>
      ) : null}

      {loading ? (
        <div style={{ color: 'var(--ink-500)', fontSize: 13.5, marginTop: 14 }}>Loading rubric…</div>
      ) : rubric && !rubric.hasRubric ? (
        <div style={{ fontSize: 13.5, color: 'var(--ink-500)', marginTop: 14 }}>
          This assignment has no rubric attached. Add one in Canvas, then return to edit it and
          link outcomes here.
        </div>
      ) : rubric && !editing ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 4 }}>{rubric.title}</div>
          {rubric.criteria.map((cr, i) => {
            const linked = cr.learning_outcome_id != null && String(cr.learning_outcome_id) !== '';
            return (
              <div key={cr.id || i} className="rubric-row" style={{ cursor: 'default' }}>
                <I.Target w={18} h={18} stroke={linked ? 'var(--green-500)' : 'var(--ink-400)'} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {cr.description?.trim() ? cr.description : `Criterion ${cr.id}`}
                  </span>
                  {linked ? (
                    <span className="pill pill-good" style={{ marginLeft: 8 }}>
                      Outcome linked
                    </span>
                  ) : null}
                  {cr.long_description?.trim() ? (
                    <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 2 }}>
                      {stripHtmlText(cr.long_description)}
                    </div>
                  ) : null}
                </div>
                <span className="rubric-pts">-- / {fmtPts(cr.points)} pts</span>
              </div>
            );
          })}
        </div>
      ) : rubric && editing ? (
        <>
          {warning ? (
            <div className="info-banner" style={{ borderColor: '#FCD34D', marginTop: 12 }}>
              <span style={{ flex: 1 }}>
                <I.Warn w={15} h={15} stroke="var(--amber-600)" /> {warning}
              </span>
            </div>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <label className="lbl">Rubric title</label>
            <input
              className="input"
              style={{ maxWidth: 460 }}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            {editCriteria.map((crit, idx) => (
              <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="Criterion description"
                    value={crit.description}
                    onChange={(e) => patchCriterion(idx, { description: e.target.value })}
                  />
                  <input
                    className="input"
                    type="number"
                    style={{ width: 90 }}
                    value={crit.points}
                    onChange={(e) => patchCriterion(idx, { points: Number(e.target.value) || 0 })}
                  />
                  <button
                    className="icon-btn"
                    title="Remove criterion"
                    onClick={() => setEditCriteria((cs) => cs.filter((_, i) => i !== idx))}
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  className="textarea"
                  style={{ marginTop: 8, minHeight: 56 }}
                  placeholder="Long description (optional)"
                  value={crit.longDescription}
                  onChange={(e) => patchCriterion(idx, { longDescription: e.target.value })}
                />
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>Outcome:</span>
                  <select
                    className="select"
                    style={{ flex: 1 }}
                    value={crit.outcomeId}
                    onChange={(e) => patchCriterion(idx, { outcomeId: e.target.value })}
                  >
                    <option value="">— Not linked —</option>
                    {outcomes.map((oc) => (
                      <option key={oc.id} value={String(oc.id)}>
                        {oc.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-600)', marginBottom: 6 }}>
                    Rating levels
                  </div>
                  {crit.ratings.map((rating, rIdx) => (
                    <div key={rIdx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <input
                        className="input"
                        style={{ flex: 1 }}
                        placeholder="Rating label"
                        value={rating.description}
                        onChange={(e) => patchRating(idx, rIdx, { description: e.target.value })}
                      />
                      <input
                        className="input"
                        type="number"
                        style={{ width: 90 }}
                        value={rating.points}
                        onChange={(e) => patchRating(idx, rIdx, { points: Number(e.target.value) || 0 })}
                      />
                      <button
                        className="icon-btn"
                        title="Remove rating"
                        onClick={() =>
                          patchCriterion(idx, { ratings: crit.ratings.filter((_, j) => j !== rIdx) })
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    className="btn-outline-add"
                    style={{ marginTop: 2, padding: '6px 12px', fontSize: 12.5 }}
                    onClick={() => patchCriterion(idx, { ratings: [...crit.ratings, newRating()] })}
                  >
                    + Add rating
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            className="btn-outline-add"
            style={{ marginTop: 12 }}
            onClick={() => setEditCriteria((cs) => [...cs, newCriterion()])}
          >
            + Add criterion
          </button>
          {outcomes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 8 }}>
              No course outcomes are linked yet — link some on the Outcomes tab to connect them
              here.
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save to Canvas'}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---- Outcomes management (Outcomes tab) ----

function OutcomesManager({
  ck,
  isStaff,
  outcomes,
  onChange,
}: {
  ck: string;
  isStaff: boolean;
  outcomes: Outcome[];
  onChange: (next: Outcome[]) => void;
}) {
  const [browsing, setBrowsing] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [desc, setDesc] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [unlinkingId, setUnlinkingId] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function mutate(body: Record<string, unknown>): Promise<Outcome[] | null> {
    const res = await fetch(`/api/courses/${ck}/alignment/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as
      | { outcomes?: Outcome[]; message?: string; error?: string }
      | null;
    if (!res.ok) {
      throw new Error(payload?.message ?? payload?.error ?? `HTTP ${res.status}`);
    }
    return Array.isArray(payload?.outcomes) ? payload.outcomes : null;
  }

  async function unlink(outcomeId: number) {
    setUnlinkingId(outcomeId);
    setError(null);
    try {
      const next = await mutate({ action: 'unlink', outcomeId });
      if (next) onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unlink failed');
    } finally {
      setUnlinkingId(null);
    }
  }

  async function createOutcome() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await mutate({
        action: 'create',
        title: title.trim(),
        description: desc.trim() || undefined,
      });
      if (next) onChange(next);
      setTitle('');
      setDesc('');
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Course Learning Outcomes</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--ink-500)', fontSize: 13.5 }}>
            The outcomes the AI grader and alignment use. Pulled live from Canvas.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setBrowsing((b) => !b)}>
            <I.Search w={15} h={15} /> Browse Library
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setCreating((c) => !c)}
            disabled={!isStaff}
            title={isStaff ? undefined : 'Outcome changes are limited to course staff.'}
          >
            <I.Plus w={15} h={15} /> Create Outcome
          </button>
        </div>
      </div>

      {!isStaff ? (
        <div style={{ marginBottom: 16 }}>
          <InfoBanner>Outcome changes are limited to course staff — browsing is read-only for your role.</InfoBanner>
        </div>
      ) : null}

      {creating ? (
        <div className="card" style={{ marginBottom: 16, background: 'var(--blue-50)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>New outcome</div>
          <input
            className="input"
            placeholder="Outcome title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <textarea
            className="textarea"
            placeholder="Description (optional)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            style={{ minHeight: 80 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button className="btn btn-secondary" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={createOutcome} disabled={busy || !title.trim()}>
              {busy ? 'Creating…' : 'Create & link to course'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <div style={{ color: 'var(--red-600)', fontSize: 13, marginBottom: 12 }}>{error}</div> : null}

      {browsing ? (
        <LibraryBrowser
          ck={ck}
          isStaff={isStaff}
          linkedIds={new Set(outcomes.map((o) => o.id))}
          onLinked={onChange}
        />
      ) : null}

      <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 16 }}>
        {outcomes.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--ink-500)', fontSize: 13.5 }}>
            No outcomes are linked to this course yet. Use “Browse Library” to link existing
            outcomes, or “Create Outcome” to add a new one.
          </div>
        ) : (
          outcomes.map((o) => (
            <div
              key={o.id}
              style={{
                padding: '14px 16px',
                borderBottom: '1px solid var(--ink-100)',
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
              }}
            >
              <I.Target w={18} h={18} stroke="var(--green-500)" />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{o.title}</div>
                {o.description ? (
                  <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 2 }}>{o.description}</div>
                ) : null}
              </div>
              <button
                className="btn btn-secondary"
                style={{ padding: '6px 12px' }}
                disabled={!isStaff || unlinkingId === o.id}
                onClick={() => unlink(o.id)}
              >
                {unlinkingId === o.id ? 'Unlinking…' : 'Unlink'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Account outcome-library browser (lazy, one group level per fetch) ----

type LibGroup = { id: number; title: string };
type LibContent = { subgroups: LibGroup[]; outcomes: Outcome[] };

function LibraryBrowser({
  ck,
  isStaff,
  linkedIds,
  onLinked,
}: {
  ck: string;
  isStaff: boolean;
  linkedIds: Set<number>;
  onLinked: (next: Outcome[]) => void;
}) {
  const [path, setPath] = React.useState<LibGroup[]>([]);
  const [accountId, setAccountId] = React.useState<number | null>(null);
  const [content, setContent] = React.useState<LibContent>({ subgroups: [], outcomes: [] });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [linkingId, setLinkingId] = React.useState<number | null>(null);
  // Ignore results from superseded fetches when the user clicks rapidly, so
  // the breadcrumb and the shown content can't desynchronise.
  const seqRef = React.useRef(0);

  const fetchGroup = React.useCallback(
    async (groupId: number | null, account: number | null): Promise<LibGroup | null> => {
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ list: 'library' });
        if (groupId != null) params.set('groupId', String(groupId));
        if (account != null) params.set('accountId', String(account));
        const res = await fetch(`/api/courses/${ck}/alignment/outcomes?${params.toString()}`);
        const body = (await res.json()) as {
          accountId?: number;
          group?: LibGroup | null;
          subgroups?: LibGroup[];
          outcomes?: Outcome[];
          message?: string;
          error?: string;
        };
        if (seq !== seqRef.current) return null; // superseded
        if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        if (typeof body.accountId === 'number') setAccountId(body.accountId);
        setContent({ subgroups: body.subgroups ?? [], outcomes: body.outcomes ?? [] });
        return body.group ?? (groupId != null ? { id: groupId, title: '' } : null);
      } catch (err) {
        if (seq === seqRef.current) {
          setError(err instanceof Error ? err.message : 'Could not load the outcome library.');
        }
        return null;
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [ck],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const root = await fetchGroup(null, null);
      if (!cancelled && root) setPath([root]);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchGroup]);

  async function drillInto(group: LibGroup) {
    // `group` is the clicked subgroup and carries its real title; the fetch
    // is used as a success/not-stale signal.
    const ok = await fetchGroup(group.id, accountId);
    if (ok) setPath((p) => [...p, group]);
  }
  async function crumbTo(index: number) {
    const target = path[index];
    if (!target) return;
    const g = await fetchGroup(index === 0 ? null : target.id, index === 0 ? null : accountId);
    if (g) setPath((p) => p.slice(0, index + 1));
  }
  async function link(outcomeId: number) {
    setLinkingId(outcomeId);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${ck}/alignment/outcomes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'link', outcomeId }),
      });
      const body = (await res.json().catch(() => null)) as
        | { outcomes?: Outcome[]; message?: string; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      if (Array.isArray(body?.outcomes)) onLinked(body.outcomes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'link failed');
    } finally {
      setLinkingId(null);
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, fontSize: 13, flexWrap: 'wrap' }}>
        <I.List w={15} h={15} stroke="var(--ink-400)" />
        {path.map((g, i) => (
          <React.Fragment key={`${g.id}-${i}`}>
            {i > 0 && <span style={{ color: 'var(--ink-300)' }}>/</span>}
            <button
              className="btn-ghost"
              style={{ padding: 0, fontWeight: i === path.length - 1 ? 600 : 500 }}
              onClick={() => crumbTo(i)}
            >
              {g.title || 'Library'}
            </button>
          </React.Fragment>
        ))}
      </div>

      {error ? <div style={{ color: 'var(--red-600)', fontSize: 13, marginBottom: 10 }}>{error}</div> : null}
      {loading ? (
        <div style={{ color: 'var(--ink-500)', fontSize: 13.5, padding: '12px 0' }}>Loading…</div>
      ) : (
        <>
          {content.subgroups.map((g) => (
            <button
              key={g.id}
              onClick={() => drillInto(g)}
              className="row-card"
              style={{ width: '100%', marginBottom: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <I.List w={16} h={16} stroke="var(--blue-500)" />
                <span style={{ fontWeight: 600, fontSize: 14 }}>{g.title}</span>
              </div>
              <I.Chevron w={16} h={16} stroke="var(--ink-400)" />
            </button>
          ))}
          {content.outcomes.map((o) => {
            const already = linkedIds.has(o.id);
            return (
              <div
                key={o.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '12px 8px',
                  borderBottom: '1px solid var(--ink-100)',
                }}
              >
                <I.Target w={18} h={18} stroke="var(--ink-400)" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.title}</div>
                  {o.description ? (
                    <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 2 }}>{o.description}</div>
                  ) : null}
                </div>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '6px 14px' }}
                  disabled={!isStaff || already || linkingId === o.id}
                  onClick={() => link(o.id)}
                >
                  {already ? 'Linked' : linkingId === o.id ? 'Linking…' : 'Link'}
                </button>
              </div>
            );
          })}
          {content.subgroups.length === 0 && content.outcomes.length === 0 ? (
            <div style={{ color: 'var(--ink-500)', fontSize: 13.5, padding: '12px 0' }}>
              This group is empty.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
