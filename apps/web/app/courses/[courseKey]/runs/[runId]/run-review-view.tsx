'use client';

// Ported from: C:\Devs\AIgrader\app\lti\runs\[runId]\run-review-view.tsx
// The SpeedGrader-style review screen, adapted to this app's runtime: the
// Canvas run document arrives via GET /api/runs/[runId]/snapshot and live
// progress via the ~3s /progress poll (decision logic in
// lib/runs/progress-poll — the predecessor used SSE). Per-criterion scores,
// comments, and the overall feedback are editable; edits flush to POST /edit
// (~1s client debounce onto the engine's 3s tier), approvals to POST
// /approve (browser-only — the approve route's mutation guard). Adds over
// the lift: per-student roster rows with GradeStatus pills,
// extraction-warning notes, resubmitted flags, cancel while running, resume
// on a stale heartbeat, and the exact C# "[As Reviewed by {name}]" post
// notice.
//
// M5 adds the in-app submission viewer (components/viewer — the C#
// SubmissionViewer port): the left pane renders the student's actual work
// (PDF/DOCX/images/spreadsheets/code) streamed same-origin, with the
// extracted-text excerpt kept as a second tab and the whole pane collapsible;
// quiz answers gain the "view full formatted answer" live fetch.

import * as React from 'react';
import { SpinButton } from '@fluentui/react-components';
import { QuizAnswerView } from '../../../../../components/viewer/QuizAnswerView';
import { SubmissionViewer } from '../../../../../components/viewer/SubmissionViewer';
import {
  decideSnapshotRefetch,
  isActiveRunStatus,
  isHeartbeatStale,
  shouldContinuePolling,
  type ProgressSample,
} from '../../../../../lib/runs/progress-poll';
import { I } from '../../_components/icons';
import { PageHead, InfoBanner, ErrorBanner } from '../../_components/ui';

// ---- wire shapes (structural mirrors of @aigrader/shared — type-only there is
// fine, but the shared package's runtime is server-only, so the client keeps
// local structural types) ----

type RubricLine = {
  criterionId: string;
  ratingId: string | null;
  points: number;
  ratingFeedback: string;
};
type Draft = { totalPoints: string; assignmentFeedback: string; rubrics: RubricLine[] };
type QuizDraft = { score: number; comment: string };

type RubricCriterion = {
  id: string;
  description: string | null;
  long_description: string | null;
  points: number;
};

type StudentRow = {
  canvasUserId: number;
  studentName: string;
  submissionType: string | null;
  attachmentMime: string | null;
  attachmentCount: number;
  extractionWarnings: string[];
  submittedAt: string | null;
  status: string;
  submissionExcerpt: string | null;
  excerptTruncated: boolean;
  aiDraft: Draft | null;
  facultyEdited: Draft | null;
  errorMessage: string | null;
  postedAt: string | null;
};

type QuizRow = {
  canvasUserId: number;
  studentName: string;
  quizSubmissionId: number;
  attempt: number;
  questionId: number;
  questionName: string;
  maxPoints: number;
  status: string;
  answerExcerpt: string | null;
  aiDraft: QuizDraft | null;
  facultyEdited: QuizDraft | null;
  errorMessage: string | null;
  postedAt: string | null;
};

type RunDoc = {
  runId: string;
  status: string;
  /** Canvas assignment id from the run document — the viewer's streaming
   * URLs are keyed on it (absent only for malformed legacy docs). */
  canvasAssignmentId?: number;
  assignmentName: string;
  pointsPossible: number | null;
  rubricSnapshot: RubricCriterion[];
  modelName: string;
  facultyName: string;
  totalCount: number;
  completedCount: number;
  errorCount: number;
  canvasQuizId: number | null;
  grades: StudentRow[];
  quizGrades: QuizRow[];
};

type Progress = ProgressSample & {
  status: string;
  cancelRequested?: boolean;
  worker?: { heartbeatAt?: string | null };
};

const STATUS_PILL: Record<string, { label: string; cls?: string; style?: React.CSSProperties }> = {
  PENDING: { label: 'Pending', cls: 'pill-notready' },
  EXTRACTING: { label: 'Extracting', cls: 'pill-notready' },
  SCORING: { label: 'Scoring', cls: 'pill-notready' },
  DRAFT: { label: 'Draft', cls: 'pill-assignment' },
  EDITED: { label: 'Edited', cls: 'pill-auto' },
  APPROVED: { label: 'Approved', cls: 'pill-good' },
  POSTED: { label: 'Posted', cls: 'pill-strong' },
  ERROR: {
    label: 'Error',
    style: { background: 'var(--red-100)', color: 'var(--red-600)' },
  },
};

function StatusPill({ status }: { status: string }) {
  const p = STATUS_PILL[status] ?? { label: status, cls: 'pill-notready' };
  return (
    <span className={'pill ' + (p.cls ?? '')} style={p.style}>
      {p.label}
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

function numerator(total: string | undefined): number {
  if (!total) return 0;
  const m = /^(\d+(?:\.\d+)?)\//.exec(total);
  return m ? Number(m[1]) : 0;
}

function pct(got: number, max: number): number {
  return max > 0 ? Math.round((got / max) * 100) : 0;
}

function sumRubric(rubric: RubricCriterion[]): number {
  return rubric.reduce((acc, c) => acc + (c.points ?? 0), 0);
}

/** The reconcile pass flags rows whose student resubmitted after grading. */
function isResubmitted(row: { errorMessage: string | null; status: string }): boolean {
  return row.status !== 'ERROR' && (row.errorMessage ?? '').toLowerCase().includes('resubmitted');
}

const REVIEWABLE = ['DRAFT', 'EDITED'];

// ---------------------------------------------------------------- container --

export function RunReviewView({
  courseKey,
  runId,
  viewerName,
  isStaff,
}: {
  courseKey: string;
  runId: string;
  viewerName: string;
  isStaff: boolean;
}) {
  const ck = encodeURIComponent(courseKey);
  const rid = encodeURIComponent(runId);
  const base = `/courses/${ck}`;

  const [run, setRun] = React.useState<RunDoc | null>(null);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [fatal, setFatal] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [pollEpoch, setPollEpoch] = React.useState(0);

  const progressRef = React.useRef<Progress | null>(null);
  const lastSnapshotAtRef = React.useRef<number | null>(null);

  const fetchSnapshot = React.useCallback(async () => {
    lastSnapshotAtRef.current = Date.now();
    const res = await fetch(`/api/runs/${rid}/snapshot?courseKey=${ck}`);
    if (!res.ok) {
      if (res.status === 404) setFatal('Grading run not found for this course.');
      return;
    }
    const body = await res.json().catch(() => null);
    if (body?.run) setRun(body.run as RunDoc);
  }, [rid, ck]);

  const fetchProgress = React.useCallback(async (): Promise<Progress | null> => {
    const res = await fetch(`/api/runs/${rid}/progress?courseKey=${ck}`);
    if (!res.ok) {
      if (res.status === 404) setFatal('Grading run not found for this course.');
      return null;
    }
    const body = await res.json().catch(() => null);
    const next = body?.progress as Progress | undefined;
    if (!next?.status) return null;

    const prev = progressRef.current;
    progressRef.current = next;
    setProgress(next);

    const decision = decideSnapshotRefetch(prev, next, lastSnapshotAtRef.current, Date.now());
    if (decision.refetch) void fetchSnapshot();
    return next;
  }, [rid, ck, fetchSnapshot]);

  // ~3s progress poll while the engine is moving; a mutation bumps pollEpoch
  // to restart the loop (e.g. approve → POSTING).
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const p = await fetchProgress();
      if (cancelled) return;
      if (p && shouldContinuePolling(p.status)) {
        timer = setTimeout(() => void tick(), 3_000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchProgress, pollEpoch]);

  const refreshAfterMutation = React.useCallback(async () => {
    await fetchSnapshot();
    setPollEpoch((n) => n + 1);
  }, [fetchSnapshot]);

  // ---- debounced edit flushing (~1s; engine persists on its 3s tier) ----
  const pendingEditRef = React.useRef<{
    key: string;
    body: Record<string, unknown>;
  } | null>(null);
  const editTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushEdit = React.useCallback(async () => {
    const pending = pendingEditRef.current;
    pendingEditRef.current = null;
    if (editTimerRef.current) {
      clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
    if (!pending) return;
    try {
      const res = await fetch(`/api/runs/${rid}/edit?courseKey=${ck}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending.body),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? `Saving the edit failed (HTTP ${res.status}).`);
      }
    } catch {
      setError('Saving the edit failed — check your connection.');
    }
  }, [rid, ck]);

  const queueEdit = React.useCallback(
    (key: string, body: Record<string, unknown>) => {
      // A different row's edit is pending → flush it before replacing.
      if (pendingEditRef.current && pendingEditRef.current.key !== key) {
        void flushEdit();
      }
      pendingEditRef.current = { key, body };
      if (editTimerRef.current) clearTimeout(editTimerRef.current);
      editTimerRef.current = setTimeout(() => void flushEdit(), 1_000);
    },
    [flushEdit],
  );

  React.useEffect(() => () => void flushEdit(), [flushEdit]);

  // ---- run-level actions ----

  const approve = React.useCallback(
    async (body: { userIds?: number[]; all?: true }) => {
      setSubmitting(true);
      setError(null);
      try {
        await flushEdit();
        const res = await fetch(`/api/runs/${rid}/approve?courseKey=${ck}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const resBody = await res.json().catch(() => null);
        if (!res.ok) throw new Error(resBody?.message ?? resBody?.error ?? `HTTP ${res.status}`);
        await refreshAfterMutation();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown error');
      } finally {
        setSubmitting(false);
      }
    },
    [rid, ck, flushEdit, refreshAfterMutation],
  );

  const cancelRun = React.useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${rid}/cancel?courseKey=${ck}`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      await refreshAfterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setSubmitting(false);
    }
  }, [rid, ck, refreshAfterMutation]);

  const resumeRun = React.useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${rid}/resume?courseKey=${ck}`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      await refreshAfterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setSubmitting(false);
    }
  }, [rid, ck, refreshAfterMutation]);

  if (fatal) {
    return (
      <div className="head-wrap">
        <InfoBanner icon={<I.Warn w={18} h={18} />}>{fatal}</InfoBanner>
      </div>
    );
  }

  const status = progress?.status ?? run?.status ?? 'PENDING';
  const stale = isHeartbeatStale(status, progress?.worker?.heartbeatAt ?? null, Date.now());
  const facultyName = run?.facultyName || viewerName;

  const shared = {
    base,
    courseKey,
    run,
    status,
    stale,
    error,
    submitting,
    isStaff,
    facultyName,
    approve,
    cancelRun,
    resumeRun,
    queueEdit,
  };

  if (run && run.canvasQuizId != null) {
    return <QuizReview {...shared} run={run} />;
  }
  return <AssignmentReview {...shared} />;
}

// ------------------------------------------------------------------- header --

function RunHeader({
  base,
  run,
  status,
  action,
}: {
  base: string;
  run: RunDoc | null;
  status: string;
  action?: React.ReactNode;
}) {
  return (
    <PageHead
      crumbs={[
        { label: 'Dashboard', href: base },
        { label: 'Grading Runs', href: `${base}/runs` },
        { label: run?.assignmentName ?? 'Run' },
        { label: 'Review' },
      ]}
      title={
        <>
          {run?.assignmentName ?? 'Grading run'}{' '}
          <span className="pill pill-programming" style={{ fontSize: 13, padding: '5px 12px' }}>
            {status}
          </span>
        </>
      }
      sub={
        run ? (
          <span style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
            <span>
              {run.completedCount}/{run.totalCount} graded
            </span>
            <span>·</span>
            <span>{run.errorCount} errors</span>
            {run.modelName ? (
              <>
                <span>·</span>
                <span>model {run.modelName}</span>
              </>
            ) : null}
          </span>
        ) : (
          'Loading run…'
        )
      }
      action={action}
    />
  );
}

function RunBanners({
  status,
  stale,
  submitting,
  isStaff,
  cancelRun,
  resumeRun,
}: {
  status: string;
  stale: boolean;
  submitting: boolean;
  isStaff: boolean;
  cancelRun: () => Promise<void>;
  resumeRun: () => Promise<void>;
}) {
  return (
    <>
      {isActiveRunStatus(status) ? (
        <div
          className="info-banner"
          style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}
        >
          <div className="left">
            <span className="icon">
              <I.Refresh w={18} h={18} />
            </span>
            {status === 'POSTING'
              ? 'Approved grades are posting to Canvas — this updates live.'
              : 'AI grading in progress — drafts appear below as they finish.'}
          </div>
          {isStaff && status !== 'POSTING' ? (
            <button className="btn btn-secondary" onClick={() => void cancelRun()} disabled={submitting}>
              Cancel run
            </button>
          ) : null}
        </div>
      ) : null}

      {stale && isStaff ? (
        <div
          className="info-banner"
          style={{
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
            borderColor: '#FCD34D',
            background: 'var(--amber-50)',
          }}
        >
          <div className="left">
            <span className="icon" style={{ color: 'var(--amber-600)' }}>
              <I.Warn w={18} h={18} />
            </span>
            This run&apos;s heartbeat is stale — it may have been interrupted. Resume to
            pick up exactly where it left off (nothing ever double-posts).
          </div>
          <button className="btn btn-primary" onClick={() => void resumeRun()} disabled={submitting}>
            Resume run
          </button>
        </div>
      ) : null}
    </>
  );
}

/** The human-in-the-loop notice — the prefix is a byte-for-byte C# parity
 * contract: every posted comment carries it. */
function WillPostAs({ facultyName }: { facultyName: string }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        color: 'var(--ink-500)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <I.Shield w={13} h={13} stroke="var(--blue-500)" /> Will post as:{' '}
      <code>[As Reviewed by {facultyName}]</code>
    </div>
  );
}

// ------------------------------------------------------- assignment review --

type SharedProps = {
  base: string;
  courseKey: string;
  run: RunDoc | null;
  status: string;
  stale: boolean;
  error: string | null;
  submitting: boolean;
  isStaff: boolean;
  facultyName: string;
  approve: (body: { userIds?: number[]; all?: true }) => Promise<void>;
  cancelRun: () => Promise<void>;
  resumeRun: () => Promise<void>;
  queueEdit: (key: string, body: Record<string, unknown>) => void;
};

function AssignmentReview(props: SharedProps) {
  const { base, courseKey, run, status, stale, error, submitting, isStaff, facultyName } = props;
  const rubric = run?.rubricSnapshot ?? [];
  const total = run?.pointsPossible ?? sumRubric(rubric);
  const grades = React.useMemo(() => run?.grades ?? [], [run]);

  const [idx, setIdx] = React.useState(0);
  const [edits, setEdits] = React.useState<Record<number, Draft>>({});
  // Left pane: live preview vs. the extracted-text excerpt, plus collapse.
  const [viewTab, setViewTab] = React.useState<'preview' | 'text'>('preview');
  const [viewerCollapsed, setViewerCollapsed] = React.useState(false);

  const current: StudentRow | undefined = grades[Math.min(idx, Math.max(grades.length - 1, 0))];
  const reviewableCount = grades.filter((g) => REVIEWABLE.includes(g.status)).length;

  const draft: Draft | null = current
    ? edits[current.canvasUserId] ?? current.facultyEdited ?? current.aiDraft ?? null
    : null;
  const locked =
    !isStaff ||
    current?.status === 'APPROVED' ||
    current?.status === 'POSTED' ||
    current?.postedAt != null;

  function setDraft(next: Draft) {
    if (!current) return;
    setEdits((m) => ({ ...m, [current.canvasUserId]: next }));
    props.queueEdit(`u${current.canvasUserId}`, {
      userId: current.canvasUserId,
      facultyEdited: next,
    });
  }
  function updateLine(i: number, patch: Partial<RubricLine>) {
    if (!draft) return;
    const rubrics = draft.rubrics.map((line, j) => (j === i ? { ...line, ...patch } : line));
    // Keep the headline score in step with per-criterion edits.
    const sum = rubrics.reduce((acc, l) => acc + (Number(l.points) || 0), 0);
    setDraft({ ...draft, rubrics, totalPoints: `${sum}/${total}` });
  }
  function setFinalScore(v: number) {
    if (!draft) return;
    setDraft({ ...draft, totalPoints: `${v}/${total}` });
  }
  function setOverall(v: string) {
    if (!draft) return;
    setDraft({ ...draft, assignmentFeedback: v });
  }

  const finalScore = numerator(draft?.totalPoints);
  const name = current?.studentName || `Canvas user #${current?.canvasUserId ?? '—'}`;

  return (
    <div className="head-wrap">
      <RunHeader
        base={base}
        run={run}
        status={status}
        action={
          grades.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                disabled={idx === 0}
              >
                <I.ArrowLeft w={14} h={14} /> Previous
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setIdx((i) => Math.min(grades.length - 1, i + 1))}
                disabled={idx >= grades.length - 1}
              >
                Next <I.ArrowRight w={14} h={14} />
              </button>
              <div className="select-pill">
                <span>
                  Student {Math.min(idx + 1, grades.length)} of {grades.length}
                </span>
              </div>
            </div>
          ) : undefined
        }
      />

      <RunBanners
        status={status}
        stale={stale}
        submitting={submitting}
        isStaff={isStaff}
        cancelRun={props.cancelRun}
        resumeRun={props.resumeRun}
      />

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      ) : null}

      {run === null ? (
        <InfoBanner>Loading the run document…</InfoBanner>
      ) : grades.length === 0 ? (
        <InfoBanner>Run is starting. Submissions appear here as the engine fans them out.</InfoBanner>
      ) : (
        <>
          {reviewableCount > 0 && isStaff ? (
            <div
              className="info-banner"
              style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}
            >
              <div className="left">
                <span className="icon">
                  <I.CheckCirc w={18} h={18} stroke="var(--blue-500)" />
                </span>
                <span>
                  {reviewableCount} draft{reviewableCount === 1 ? '' : 's'} ready for review.{' '}
                  <span style={{ color: 'var(--ink-500)' }}>
                    Approving posts as <code>[As Reviewed by {facultyName}]</code>.
                  </span>
                </span>
              </div>
              <button
                className="btn btn-success"
                onClick={() => void props.approve({ all: true })}
                disabled={submitting}
              >
                {submitting ? 'Working…' : `Approve all ${reviewableCount} & Post to Canvas`}
              </button>
            </div>
          ) : null}

          {/* Per-student roster */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Submitted</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {grades.map((g, i) => {
                  const rowDraft = edits[g.canvasUserId] ?? g.facultyEdited ?? g.aiDraft;
                  return (
                    <tr
                      key={g.canvasUserId}
                      className={i === idx ? 'selected' : ''}
                      onClick={() => setIdx(i)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontWeight: 600, fontSize: 13.5 }}>
                        {g.studentName || `Canvas user #${g.canvasUserId}`}
                      </td>
                      <td>
                        <StatusPill status={g.status} />
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {rowDraft ? `${numerator(rowDraft.totalPoints)}/${total}` : '—'}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>
                        {g.submittedAt
                          ? new Date(g.submittedAt).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                            })
                          : '—'}
                      </td>
                      <td style={{ fontSize: 12.5, maxWidth: 260 }}>
                        {isResubmitted(g) ? (
                          <span className="pill pill-review">Resubmitted since graded</span>
                        ) : null}
                        {g.extractionWarnings.length > 0 ? (
                          <span
                            className="pill pill-review"
                            title={g.extractionWarnings.join('\n')}
                            style={{ marginLeft: isResubmitted(g) ? 6 : 0 }}
                          >
                            {g.extractionWarnings.length} extraction warning
                            {g.extractionWarnings.length === 1 ? '' : 's'}
                          </span>
                        ) : null}
                        {g.status === 'ERROR' ? (
                          <span style={{ color: 'var(--red-600)' }}>
                            {g.errorMessage ?? 'Grading failed'}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Detail: submission left, AI grading right */}
          {current ? (
            <div className="sg-grid">
              <div>
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div className="sg-stu-head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="stu-avatar">{initialsOf(current.studentName)}</div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
                        <div style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>
                          Canvas user #{current.canvasUserId} · {current.status}
                          {current.attachmentCount > 0
                            ? ` · ${current.attachmentCount} attachment${current.attachmentCount === 1 ? '' : 's'}`
                            : ''}
                        </div>
                      </div>
                    </div>
                    <StatusPill status={current.status} />
                  </div>
                  <div className="sg-tabs" style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      className={'sg-tab ' + (viewTab === 'preview' ? 'active' : '')}
                      onClick={() => setViewTab('preview')}
                    >
                      Submission
                    </button>
                    <button
                      className={'sg-tab ' + (viewTab === 'text' ? 'active' : '')}
                      onClick={() => setViewTab('text')}
                    >
                      Extracted text
                    </button>
                    <span style={{ flex: 1 }} />
                    <button
                      className="sg-tab"
                      title={viewerCollapsed ? 'Expand the submission pane' : 'Collapse the submission pane'}
                      onClick={() => setViewerCollapsed((c) => !c)}
                    >
                      {viewerCollapsed ? '⌄ Expand' : '⌃ Collapse'}
                    </button>
                  </div>
                  <div style={{ padding: 20 }}>
                    {current.extractionWarnings.length > 0 ? (
                      <div
                        className="info-banner"
                        style={{
                          borderColor: '#FCD34D',
                          background: 'var(--amber-50)',
                          marginBottom: 14,
                        }}
                      >
                        <div className="left">
                          <span className="icon" style={{ color: 'var(--amber-600)' }}>
                            <I.Warn w={18} h={18} />
                          </span>
                          <span>
                            {current.extractionWarnings.map((w, i) => (
                              <span key={i} style={{ display: 'block' }}>
                                {w}
                              </span>
                            ))}
                          </span>
                        </div>
                      </div>
                    ) : null}
                    {isResubmitted(current) ? (
                      <div
                        className="info-banner"
                        style={{
                          borderColor: '#FCD34D',
                          background: 'var(--amber-50)',
                          marginBottom: 14,
                        }}
                      >
                        <div className="left">
                          <span className="icon" style={{ color: 'var(--amber-600)' }}>
                            <I.Warn w={18} h={18} />
                          </span>
                          {current.errorMessage}
                        </div>
                      </div>
                    ) : null}
                    {['PENDING', 'EXTRACTING', 'SCORING'].includes(current.status) ? (
                      <InfoBanner>Grading in progress — this updates live.</InfoBanner>
                    ) : null}
                    {current.status === 'ERROR' ? (
                      <ErrorBanner>
                        <span>
                          {current.errorMessage ?? 'Unknown error'}
                        </span>
                      </ErrorBanner>
                    ) : null}
                    {viewerCollapsed ? null : viewTab === 'preview' &&
                      typeof run?.canvasAssignmentId === 'number' ? (
                      // The live document viewer (M5): student work streamed
                      // same-origin — the full submission stays in Canvas.
                      <div className="sg-preview" style={{ position: 'relative', top: 0 }}>
                        <SubmissionViewer
                          key={current.canvasUserId}
                          courseKey={courseKey}
                          assignmentId={run.canvasAssignmentId}
                          userId={current.canvasUserId}
                          fallbackExcerpt={current.submissionExcerpt}
                          fallbackTruncated={current.excerptTruncated}
                        />
                      </div>
                    ) : (
                      <div className="code-block">
                        <div className="code-block-head">
                          <span
                            style={{
                              fontFamily: 'var(--font-mono), monospace',
                              fontSize: 13,
                              color: 'var(--ink-700)',
                            }}
                          >
                            {current.attachmentMime ?? current.submissionType ?? 'submission'}
                          </span>
                        </div>
                        <div
                          className="code-block-body code"
                          style={{ padding: 16, whiteSpace: 'pre-wrap' }}
                        >
                          {current.submissionExcerpt ?? 'No extracted text available.'}
                          {current.excerptTruncated ? (
                            <span style={{ display: 'block', color: 'var(--ink-400)', marginTop: 12 }}>
                              … preview truncated — the full submission stays in Canvas.
                            </span>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div className="sg-head-right">
                    <div style={{ display: 'flex', gap: 24 }}>
                      <button className="sg-tab active">
                        <I.Sparkle w={14} h={14} stroke="var(--blue-500)" /> AI Grading
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {locked && current.status !== 'ERROR' ? (
                        <span style={{ fontSize: 12.5, color: 'var(--green-600)', fontWeight: 600 }}>
                          {current.status === 'POSTED' ? 'Posted to Canvas' : 'Approved'}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ padding: '20px 24px 24px' }}>
                    {!draft ? (
                      <InfoBanner>No AI draft yet for this submission.</InfoBanner>
                    ) : (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-end',
                            marginBottom: 12,
                          }}
                        >
                          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Rubric</h2>
                          <div style={{ textAlign: 'right' }}>
                            <div>
                              <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>
                                {finalScore}
                              </span>{' '}
                              <span style={{ color: 'var(--ink-500)' }}>/{total} pts</span>{' '}
                              <span style={{ color: 'var(--ink-500)', marginLeft: 6 }}>
                                {pct(finalScore, total)}%
                              </span>
                            </div>
                          </div>
                        </div>

                        <table className="rubric-tbl">
                          <thead>
                            <tr>
                              <th style={{ paddingLeft: 0 }}>Criteria</th>
                              <th>Points</th>
                              <th>Feedback</th>
                            </tr>
                          </thead>
                          <tbody>
                            {draft.rubrics.map((line, i) => {
                              const criterion = rubric.find(
                                (c) => String(c.id) === String(line.criterionId),
                              );
                              const max = criterion?.points ?? 0;
                              const ok = max > 0 ? line.points / max >= 0.7 : true;
                              return (
                                <tr key={`${line.criterionId}-${i}`}>
                                  <td style={{ paddingLeft: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                                      {ok ? (
                                        <I.CheckCirc w={18} h={18} stroke="var(--green-500)" />
                                      ) : (
                                        <I.Warn w={18} h={18} stroke="var(--amber-500)" />
                                      )}
                                      <div>
                                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                                          {criterion?.description ?? `Criterion ${line.criterionId}`}
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--ink-500)' }}>
                                          / {max} pts
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                  <td>
                                    <input
                                      className="input"
                                      type="number"
                                      aria-label={`Points for ${criterion?.description ?? line.criterionId}`}
                                      value={String(line.points)}
                                      disabled={locked}
                                      onChange={(e) =>
                                        updateLine(i, { points: Number(e.target.value) || 0 })
                                      }
                                      style={{ width: 90 }}
                                    />
                                  </td>
                                  <td style={{ maxWidth: 360 }}>
                                    <textarea
                                      className="textarea"
                                      aria-label={`Feedback for ${criterion?.description ?? line.criterionId}`}
                                      value={line.ratingFeedback}
                                      disabled={locked}
                                      onChange={(e) => updateLine(i, { ratingFeedback: e.target.value })}
                                      style={{ minHeight: 60, fontSize: 13 }}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>

                        <div style={{ marginTop: 24 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                            Overall Feedback
                          </div>
                          <textarea
                            className="textarea"
                            aria-label="Overall feedback"
                            value={draft.assignmentFeedback}
                            disabled={locked}
                            onChange={(e) => setOverall(e.target.value)}
                            style={{ minHeight: 120 }}
                          />
                          <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 6 }}>
                            Generated by AI. Please review before posting.
                          </div>
                        </div>

                        <div style={{ marginTop: 24 }}>
                          <label className="lbl">Final Score</label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                            <SpinButton
                              value={finalScore}
                              min={0}
                              max={total}
                              disabled={locked}
                              onChange={(_, data) => {
                                const v = data.value ?? Number(data.displayValue);
                                if (typeof v === 'number' && !Number.isNaN(v)) setFinalScore(v);
                              }}
                            />
                            <span style={{ color: 'var(--ink-500)', fontSize: 13.5 }}>/ {total} pts</span>
                          </div>
                        </div>

                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 12,
                            marginTop: 20,
                          }}
                        >
                          <WillPostAs facultyName={facultyName} />
                          <button
                            className="btn btn-primary"
                            onClick={() => void props.approve({ userIds: [current.canvasUserId] })}
                            disabled={submitting || locked}
                          >
                            {locked
                              ? current.status === 'POSTED'
                                ? 'Posted'
                                : 'Approved'
                              : submitting
                                ? 'Working…'
                                : 'Approve & Post to Canvas'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------- quiz review --
// One student attempt at a time: the answer excerpt per essay question on the
// left, the editable per-question score + comment on the right.

type QuizGroup = {
  quizSubmissionId: number;
  canvasUserId: number;
  studentName: string;
  attempt: number;
  questions: QuizRow[];
};

function groupQuizRows(rows: QuizRow[]): QuizGroup[] {
  const byId = new Map<number, QuizGroup>();
  for (const row of rows) {
    let group = byId.get(row.quizSubmissionId);
    if (!group) {
      group = {
        quizSubmissionId: row.quizSubmissionId,
        canvasUserId: row.canvasUserId,
        studentName: row.studentName,
        attempt: row.attempt,
        questions: [],
      };
      byId.set(row.quizSubmissionId, group);
    }
    group.questions.push(row);
  }
  return [...byId.values()];
}

function QuizReview(props: SharedProps & { run: RunDoc }) {
  const { base, courseKey, run, status, stale, error, submitting, isStaff, facultyName } = props;
  const groups = React.useMemo(() => groupQuizRows(run.quizGrades), [run.quizGrades]);
  const [idx, setIdx] = React.useState(0);
  // edits[quizSubmissionId][questionId]
  const [edits, setEdits] = React.useState<Record<number, Record<number, QuizDraft>>>({});

  // "View full formatted answer": live-fetched from Canvas via the engine,
  // sanitized server-side, cached per (attempt, question). '' = fetched but
  // nothing richer than the excerpt exists (QuizAnswerView semantics).
  const [fullAnswers, setFullAnswers] = React.useState<Record<string, string>>({});
  const [loadingFull, setLoadingFull] = React.useState<Record<string, boolean>>({});
  const requestFullAnswer = React.useCallback(
    async (q: QuizRow) => {
      const key = `${q.quizSubmissionId}:${q.questionId}`;
      setLoadingFull((m) => ({ ...m, [key]: true }));
      try {
        const res = await fetch('/api/submission-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            courseKey,
            kind: 'quiz-answer',
            quizSubmissionId: q.quizSubmissionId,
            questionId: q.questionId,
          }),
        });
        const body = (await res.json().catch(() => null)) as { html?: string } | null;
        setFullAnswers((m) => ({
          ...m,
          [key]: res.ok && typeof body?.html === 'string' ? body.html : '',
        }));
      } catch {
        setFullAnswers((m) => ({ ...m, [key]: '' }));
      } finally {
        setLoadingFull((m) => ({ ...m, [key]: false }));
      }
    },
    [courseKey],
  );

  const current = groups[Math.min(idx, Math.max(groups.length - 1, 0))];
  const reviewableCount = groups.filter((g) =>
    g.questions.some((q) => REVIEWABLE.includes(q.status)),
  ).length;

  function draftFor(g: QuizGroup, q: QuizRow): QuizDraft | null {
    return edits[g.quizSubmissionId]?.[q.questionId] ?? q.facultyEdited ?? q.aiDraft ?? null;
  }

  function setQuestionDraft(g: QuizGroup, q: QuizRow, patch: Partial<QuizDraft>) {
    const next = { ...(draftFor(g, q) ?? { score: 0, comment: '' }), ...patch };
    setEdits((m) => ({
      ...m,
      [g.quizSubmissionId]: { ...(m[g.quizSubmissionId] ?? {}), [q.questionId]: next },
    }));
    props.queueEdit(`q${g.quizSubmissionId}:${q.questionId}`, {
      userId: g.canvasUserId,
      facultyEdited: next,
      quizSubmissionId: g.quizSubmissionId,
      questionId: q.questionId,
    });
  }

  const name = current?.studentName || `Canvas user #${current?.canvasUserId ?? '—'}`;
  const attemptLocked =
    !isStaff ||
    (current?.questions.every(
      (q) => q.status === 'APPROVED' || q.status === 'POSTED' || q.postedAt != null,
    ) ??
      true);

  return (
    <div className="head-wrap">
      <RunHeader
        base={base}
        run={run}
        status={status}
        action={
          groups.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                disabled={idx === 0}
              >
                <I.ArrowLeft w={14} h={14} /> Previous
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setIdx((i) => Math.min(groups.length - 1, i + 1))}
                disabled={idx >= groups.length - 1}
              >
                Next <I.ArrowRight w={14} h={14} />
              </button>
              <div className="select-pill">
                <span>
                  Student {Math.min(idx + 1, groups.length)} of {groups.length}
                </span>
              </div>
            </div>
          ) : undefined
        }
      />

      <RunBanners
        status={status}
        stale={stale}
        submitting={submitting}
        isStaff={isStaff}
        cancelRun={props.cancelRun}
        resumeRun={props.resumeRun}
      />

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <InfoBanner>
          {isActiveRunStatus(status)
            ? 'Run is starting. Quiz answers appear here as the engine fans them out.'
            : 'No essay (AI-gradable) questions with submitted answers were found on this quiz. Auto-graded question types are scored by Canvas and are not shown here.'}
        </InfoBanner>
      ) : (
        <>
          {reviewableCount > 0 && isStaff ? (
            <div
              className="info-banner"
              style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}
            >
              <div className="left">
                <span className="icon">
                  <I.CheckCirc w={18} h={18} stroke="var(--blue-500)" />
                </span>
                <span>
                  {reviewableCount} student attempt{reviewableCount === 1 ? '' : 's'} ready to
                  review.{' '}
                  <span style={{ color: 'var(--ink-500)' }}>
                    Approving posts as <code>[As Reviewed by {facultyName}]</code>.
                  </span>
                </span>
              </div>
              <button
                className="btn btn-success"
                onClick={() => void props.approve({ all: true })}
                disabled={submitting}
              >
                {submitting ? 'Working…' : `Approve all ${reviewableCount} & Post to Canvas`}
              </button>
            </div>
          ) : null}

          {current ? (
            <>
              <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
                <div className="sg-stu-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="stu-avatar">{initialsOf(current.studentName)}</div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
                      <div style={{ fontSize: 12.5, color: 'var(--ink-500)' }}>
                        Canvas user #{current.canvasUserId} · attempt {current.attempt} ·{' '}
                        {current.questions.length} essay question
                        {current.questions.length === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {current.questions.map((q) => {
                  const d = draftFor(current, q);
                  const locked =
                    !isStaff ||
                    q.status === 'APPROVED' ||
                    q.status === 'POSTED' ||
                    q.postedAt != null;
                  const grading = ['PENDING', 'EXTRACTING', 'SCORING'].includes(q.status);
                  return (
                    <div key={`${q.quizSubmissionId}-${q.questionId}`} className="sg-grid">
                      <div>
                        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                          <div className="sg-tabs">
                            <button className="sg-tab active">{q.questionName || 'Question'}</button>
                          </div>
                          <div style={{ padding: 20 }}>
                            {grading ? (
                              <InfoBanner>Grading in progress — this updates live.</InfoBanner>
                            ) : q.status === 'ERROR' ? (
                              <ErrorBanner>
                                <span>
                                  {q.errorMessage ?? 'Unknown error'}
                                </span>
                              </ErrorBanner>
                            ) : q.answerExcerpt ? (
                              <QuizAnswerView
                                excerpt={q.answerExcerpt}
                                fullHtml={fullAnswers[`${q.quizSubmissionId}:${q.questionId}`] ?? null}
                                loading={loadingFull[`${q.quizSubmissionId}:${q.questionId}`] === true}
                                onRequestFull={() => void requestFullAnswer(q)}
                              />
                            ) : (
                              <div className="sg-empty" style={{ padding: 16 }}>
                                No answer text available.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                          <div className="sg-head-right">
                            <div style={{ display: 'flex', gap: 24 }}>
                              <button className="sg-tab active">
                                <I.Sparkle w={14} h={14} stroke="var(--blue-500)" /> AI Grading
                              </button>
                            </div>
                            <div style={{ color: 'var(--ink-500)', fontSize: 13 }}>
                              max {q.maxPoints} pts · <StatusPill status={q.status} />
                            </div>
                          </div>
                          <div style={{ padding: '20px 24px 24px' }}>
                            {!d ? (
                              <InfoBanner>No AI draft yet for this question.</InfoBanner>
                            ) : (
                              <>
                                <div>
                                  <label className="lbl">Score</label>
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      marginTop: 8,
                                    }}
                                  >
                                    <input
                                      className="input"
                                      type="number"
                                      min={0}
                                      max={q.maxPoints}
                                      aria-label={`Score for ${q.questionName || 'question'}`}
                                      value={String(d.score)}
                                      disabled={locked}
                                      onChange={(e) => {
                                        const v = Number(e.target.value);
                                        const clamped = Number.isNaN(v)
                                          ? 0
                                          : Math.min(Math.max(v, 0), q.maxPoints);
                                        setQuestionDraft(current, q, { score: clamped });
                                      }}
                                      style={{ width: 100 }}
                                    />
                                    <span style={{ color: 'var(--ink-500)', fontSize: 13.5 }}>
                                      / {q.maxPoints} pts
                                    </span>
                                  </div>
                                </div>
                                <div style={{ marginTop: 20 }}>
                                  <label className="lbl">Feedback</label>
                                  <textarea
                                    className="textarea"
                                    aria-label={`Feedback for ${q.questionName || 'question'}`}
                                    value={d.comment}
                                    disabled={locked}
                                    onChange={(e) =>
                                      setQuestionDraft(current, q, { comment: e.target.value })
                                    }
                                    style={{ minHeight: 120, marginTop: 8 }}
                                  />
                                  <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 6 }}>
                                    Generated by AI. Please review before posting.
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  marginTop: 20,
                }}
              >
                <WillPostAs facultyName={facultyName} />
                <button
                  className="btn btn-primary"
                  onClick={() => void props.approve({ userIds: [current.canvasUserId] })}
                  disabled={submitting || attemptLocked}
                >
                  {attemptLocked
                    ? 'Approved'
                    : submitting
                      ? 'Working…'
                      : 'Approve & Post to Canvas'}
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
