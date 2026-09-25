'use client';

// Ported from: C:\Devs\AIgrader\app\lti\assignments\[aid]\assignment-view.tsx
// Prepare AI Grading: assignment details, instructions preview, rubric
// display, share toggles (persisted as per-assignment prep settings),
// template/key material upload, one-off run instructions, and START RUN.
// Deltas from the lift: instructions and rubric are read-only here (the
// rubric editor lives on the Outcomes page); share toggles persist through
// /resources prep instead of riding the run body; run start goes through
// POST /api/courses/[courseKey]/runs.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Checkbox, Textarea } from '@fluentui/react-components';
import { I } from '../../../_components/icons';
import { PageHead, PrepStep, Field, InfoBanner, ErrorBanner } from '../../../_components/ui';

type RubricCriterion = {
  id: string;
  description: string | null;
  long_description: string | null;
  points: number;
  learning_outcome_id: number | string | null;
};

type AssignmentDetail = {
  id: number;
  name: string;
  descriptionHtml: string | null;
  submissionTypes: string[];
  pointsPossible: number | null;
  dueAt: string | null;
  published: boolean;
  itemType: 'assignment' | 'discussion' | 'quiz';
  quizId: number | null;
  discussionTopicId: number | null;
  hasRubric: boolean;
  rubric: RubricCriterion[];
};

type Counts = { total: number; submitted: number; gradable: number };
type QuizInfo = { quizId: number; aiGradableQuestions: number; autoGradedQuestions: number };
type Prep = { customInstructions: string; shareRubric: boolean; shareInstructions: boolean };
type Material = {
  kind: 'TEMPLATE' | 'KEY';
  fileName: string;
  originalFilename: string;
  contentType: string | null;
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function PrepareView({
  courseKey,
  assignmentId,
  courseId,
  canvasBaseUrl,
  isStaff,
}: {
  courseKey: string;
  assignmentId: number;
  courseId: string;
  canvasBaseUrl: string;
  isStaff: boolean;
}) {
  const router = useRouter();
  const ck = encodeURIComponent(courseKey);
  const base = `/courses/${ck}`;

  const [detail, setDetail] = React.useState<AssignmentDetail | null>(null);
  const [counts, setCounts] = React.useState<Counts | null>(null);
  const [quiz, setQuiz] = React.useState<QuizInfo | null>(null);
  const [prep, setPrep] = React.useState<Prep>({
    customInstructions: '',
    shareRubric: true,
    shareInstructions: true,
  });
  const [materials, setMaterials] = React.useState<Material[]>([]);
  const [profileExists, setProfileExists] = React.useState<boolean | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savingPrep, setSavingPrep] = React.useState(false);

  const loadResources = React.useCallback(async () => {
    const res = await fetch(`/api/courses/${ck}/resources?assignmentId=${assignmentId}`);
    if (!res.ok) return;
    const body = await res.json();
    if (body?.prep) setPrep(body.prep as Prep);
    if (Array.isArray(body?.resources)) setMaterials(body.resources);
  }, [ck, assignmentId]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [detailRes, profileRes] = await Promise.allSettled([
        fetch(`/api/courses/${ck}/assignment-detail?assignmentId=${assignmentId}`).then(
          async (r) => ({ ok: r.ok, body: await r.json() }),
        ),
        fetch(`/api/courses/${ck}/profile`).then((r) => r.json()),
      ]);
      if (cancelled) return;
      if (detailRes.status === 'fulfilled') {
        if (!detailRes.value.ok) {
          setLoadError(detailRes.value.body?.message ?? 'Could not load the assignment.');
        } else {
          setDetail(detailRes.value.body.assignment as AssignmentDetail);
          setCounts(detailRes.value.body.counts as Counts);
          setQuiz((detailRes.value.body.quiz as QuizInfo | null) ?? null);
        }
      }
      if (profileRes.status === 'fulfilled') {
        setProfileExists(Boolean(profileRes.value?.exists));
      }
      await loadResources();
    })();
    return () => {
      cancelled = true;
    };
  }, [ck, assignmentId, loadResources]);

  async function savePrep(next: Prep) {
    setPrep(next);
    setSavingPrep(true);
    try {
      await fetch(`/api/courses/${ck}/resources`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignmentId, prep: next }),
      });
    } finally {
      setSavingPrep(false);
    }
  }

  async function launch() {
    if (!detail) return;
    setSubmitting(true);
    setError(null);
    try {
      const target =
        detail.itemType === 'quiz'
          ? { kind: 'quiz', assignmentId, ...(detail.quizId ? { quizId: detail.quizId } : {}) }
          : detail.itemType === 'discussion'
            ? {
                kind: 'discussion',
                assignmentId,
                ...(detail.discussionTopicId ? { discussionId: detail.discussionTopicId } : {}),
              }
            : { kind: 'assignment', assignmentId };
      const res = await fetch(`/api/courses/${ck}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, instructions: notes.trim() || null }),
      });
      const body = await res.json().catch(() => null);
      if (res.status !== 202 || !body?.runId) {
        throw new Error(body?.message ?? `Run did not start (HTTP ${res.status}).`);
      }
      router.push(`${base}/runs/${encodeURIComponent(String(body.runId))}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="head-wrap">
        <ErrorBanner>{loadError}</ErrorBanner>
      </div>
    );
  }

  const a = detail;
  const isQuiz = a?.itemType === 'quiz';
  const isDiscussion = a?.itemType === 'discussion';

  // When Canvas returns no roster, total is 0 — show the submission count
  // rather than a misleading "0 / 0".
  const submittedLabel = counts
    ? counts.total > 0
      ? `${counts.submitted} / ${counts.total} (${Math.round((counts.submitted / counts.total) * 100)}%)`
      : `${counts.gradable} submitted`
    : '—';
  const dueLabel = a?.dueAt
    ? new Date(a.dueAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'No due date';

  const canvasLink = a
    ? isQuiz && a.quizId
      ? `${canvasBaseUrl}/courses/${courseId}/quizzes/${a.quizId}`
      : `${canvasBaseUrl}/courses/${courseId}/assignments/${a.id}`
    : null;

  const instructionsPreview = a ? stripHtml(a.descriptionHtml ?? '') : '';

  return (
    <div className="head-wrap">
      <PageHead
        crumbs={[
          { label: 'Dashboard', href: base },
          { label: 'Assignments', href: `${base}/assignments` },
          { label: a?.name ?? `Assignment ${assignmentId}` },
          { label: 'Grade with AI' },
        ]}
        title="Prepare AI Grading"
        sparkle
        sub="Review the assignment details, rubric, and instructions. Add any additional guidance for the AI grader."
      />

      <div className="card">
        <div className="prep-steps">
          <PrepStep n="1" title="Prepare" sub="Review assignment details" active />
          <div className="prep-line active" />
          <PrepStep n="2" title="AI Grading" sub="AI analyzes and drafts scores" />
          <div className="prep-line" />
          <PrepStep n="3" title="Review" sub="Approve every draft before it posts" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}>
        <div className="card">
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 20px' }}>Assignment Details</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, rowGap: 20 }}>
            <Field label="Assignment">{a?.name ?? '…'}</Field>
            <Field label="Due Date">{dueLabel}</Field>
            <Field label="Type">
              {a ? a.submissionTypes.join(', ') || 'Assignment' : '…'}
            </Field>
            <Field label="Submissions">{submittedLabel}</Field>
            <Field label="Points">{a?.pointsPossible ?? '—'}</Field>
            <Field label={isQuiz ? 'Essay questions' : 'Gradable now'}>
              {isQuiz ? (
                quiz ? (
                  `${quiz.aiGradableQuestions} of ${quiz.aiGradableQuestions + quiz.autoGradedQuestions}`
                ) : (
                  <span style={{ color: 'var(--ink-400)' }}>—</span>
                )
              ) : counts ? (
                `${counts.gradable}`
              ) : (
                <span style={{ color: 'var(--ink-400)' }}>—</span>
              )}
            </Field>
          </div>
          <div style={{ marginTop: 22 }}>
            <InfoBanner>
              {isQuiz
                ? quiz && quiz.autoGradedQuestions > 0
                  ? `The AI grades the ${quiz.aiGradableQuestions} essay question${quiz.aiGradableQuestions === 1 ? '' : 's'} on this quiz. The other ${quiz.autoGradedQuestions} question${quiz.autoGradedQuestions === 1 ? ' is' : 's are'} auto-scored by Canvas and left unchanged.`
                  : 'The AI grades the essay questions on this quiz, one student attempt at a time. Auto-scored questions are left to Canvas.'
                : isDiscussion
                  ? 'Each student\u2019s discussion posts are gathered into one submission for grading.'
                  : 'AI grading will be applied to all eligible submissions.'}
            </InfoBanner>
          </div>
          {counts ? (
            <div
              style={{
                marginTop: 12,
                fontSize: 12.5,
                color: 'var(--ink-500)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <I.Bars w={13} h={13} /> {counts.gradable} submission
              {counts.gradable === 1 ? '' : 's'} ready for AI drafting. Each one is graded in
              its own private Codex session; nothing posts until you approve it.
            </div>
          ) : null}
        </div>

        <div>
          <div className="card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 14,
              }}
            >
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 600,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <I.Doc w={18} h={18} stroke="var(--blue-500)" /> Instructions
              </h2>
              {canvasLink ? (
                <a
                  className="btn-ghost"
                  href={canvasLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  View in Canvas <I.External w={13} h={13} />
                </a>
              ) : null}
            </div>
            <p
              style={{
                fontSize: 13.5,
                color: 'var(--ink-700)',
                margin: 0,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
              }}
            >
              {a
                ? instructionsPreview.slice(0, 600) ||
                  'No instructions provided on this assignment.'
                : 'Loading…'}
              {instructionsPreview.length > 600 ? '…' : ''}
            </p>
          </div>

          {/* Quizzes are graded per-question, not against a rubric. */}
          {!isQuiz ? (
            <div className="card" style={{ marginTop: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 14px' }}>Rubric</h2>
              {a && a.rubric.length > 0 ? (
                <div>
                  {a.rubric.map((c) => (
                    <div key={c.id} className="rubric-row" style={{ cursor: 'default' }}>
                      <I.Target
                        w={16}
                        h={16}
                        stroke={c.learning_outcome_id ? 'var(--green-500)' : 'var(--ink-400)'}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>
                          {c.description ?? `Criterion ${c.id}`}
                        </span>
                        {c.learning_outcome_id ? (
                          <span className="pill pill-good" style={{ marginLeft: 8 }}>
                            Outcome linked
                          </span>
                        ) : null}
                        {c.long_description ? (
                          <div style={{ fontSize: 12.5, color: 'var(--ink-500)', marginTop: 2 }}>
                            {stripHtml(c.long_description)}
                          </div>
                        ) : null}
                      </div>
                      <span className="rubric-pts">-- / {c.points} pts</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13.5, color: 'var(--ink-500)' }}>
                  {a
                    ? 'This assignment has no rubric attached. Add one in Canvas and reload this page.'
                    : 'Loading…'}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {profileExists === false ? (
        <div className="info-banner" style={{ marginTop: 20, borderColor: '#FCD34D' }}>
          <div className="left">
            <span className="icon" style={{ color: 'var(--amber-600)' }}>
              <I.Warn w={18} h={18} />
            </span>
            No AI grading profile is configured for this course yet — grading will use defaults.{' '}
            <Link href={`${base}/profile`} style={{ color: 'var(--blue-600)', fontWeight: 500 }}>
              Set up the profile
            </Link>
            .
          </div>
        </div>
      ) : profileExists === true ? (
        <div className="info-banner" style={{ marginTop: 20 }}>
          <div className="left">
            <span className="icon">
              <I.Sparkle w={18} h={18} stroke="var(--blue-500)" />
            </span>
            Grading uses this course&apos;s AI profile.{' '}
            <Link href={`${base}/profile`} style={{ color: 'var(--blue-600)', fontWeight: 500 }}>
              Edit profile
            </Link>
            .
          </div>
        </div>
      ) : null}

      {/* Template/key materials are assignment-grading inputs; not applicable
          to per-question quiz grading. */}
      {!isQuiz ? (
        <MaterialsCard
          ck={ck}
          assignmentId={assignmentId}
          assignmentName={a?.name ?? ''}
          materials={materials}
          disabled={!isStaff}
          onChanged={loadResources}
        />
      ) : null}

      <div className="card" style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 6px' }}>What the AI Grader Sees</h2>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-500)' }}>
          {isQuiz
            ? 'Choose which context to send with each question. Saved with this assignment.'
            : 'Choose which context to send with each submission. Saved with this assignment.'}
          {savingPrep ? ' Saving…' : ''}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
          <Checkbox
            checked={prep.shareInstructions}
            disabled={!isStaff}
            onChange={(_, data) =>
              void savePrep({ ...prep, shareInstructions: Boolean(data.checked) })
            }
            label={isQuiz ? 'Include the question prompt' : 'Include the assignment instructions'}
          />
          {!isQuiz ? (
            <Checkbox
              checked={prep.shareRubric}
              disabled={!isStaff}
              onChange={(_, data) => void savePrep({ ...prep, shareRubric: Boolean(data.checked) })}
              label="Include the rubric (when the assignment has one)"
            />
          ) : null}
        </div>

        <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 6px' }}>
          Additional Details for the AI Grader (Optional)
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ink-500)' }}>
          Add any specific guidance, focus areas, or context the AI should consider when grading
          this assignment. Applies to this run only.
        </p>
        <Textarea
          value={notes}
          onChange={(_, data) => setNotes(data.value.slice(0, 1000))}
          placeholder="e.g., focus on clarity of argument and use of primary sources; flag unsupported claims."
          resize="vertical"
          style={{ minHeight: 110, width: '100%' }}
        />
        <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--ink-400)', marginTop: 6 }}>
          {notes.length} / 1000
        </div>

        {error ? (
          <div style={{ marginTop: 14 }}>
            <ErrorBanner>{error}</ErrorBanner>
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 16,
          }}
        >
          <button className="btn btn-secondary" onClick={() => router.push(`${base}/assignments`)}>
            <I.ArrowLeft w={14} h={14} /> Back to Assignments
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-secondary" onClick={() => router.push(`${base}/assignments`)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={launch}
              disabled={submitting || !detail || !isStaff}
            >
              {submitting ? 'Launching…' : 'Launch AI Grading'} <I.Send w={14} h={14} />
            </button>
          </div>
        </div>
        <div
          style={{
            textAlign: 'right',
            marginTop: 10,
            fontSize: 12,
            color: 'var(--ink-500)',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <I.Shield w={13} h={13} stroke="var(--blue-500)" /> Nothing posts to Canvas until you
          review and approve it.
        </div>
      </div>
    </div>
  );
}

function MaterialsCard({
  ck,
  assignmentId,
  assignmentName,
  materials,
  disabled,
  onChanged,
}: {
  ck: string;
  assignmentId: number;
  assignmentName: string;
  materials: Material[];
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const base = `/api/courses/${ck}/resources`;

  async function upload(kind: 'TEMPLATE' | 'KEY', file: File) {
    setBusy(kind);
    setError(null);
    try {
      const form = new FormData();
      form.append('kind', kind);
      form.append('assignmentId', String(assignmentId));
      form.append('assignmentName', assignmentName);
      form.append('file', file);
      const res = await fetch(base, { method: 'POST', body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setBusy(null);
    }
  }

  async function remove(kind: 'TEMPLATE' | 'KEY') {
    setBusy(kind);
    setError(null);
    try {
      await fetch(`${base}?assignmentId=${assignmentId}&kind=${kind}`, { method: 'DELETE' });
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 6px' }}>
        Grading Materials (Optional)
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ink-500)' }}>
        Upload the template students started from and a grading key. These travel with the course.
        For an Excel key, the tool checks each submission against the key automatically.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <MaterialSlot
          label="Student Template"
          hint="The starter file given to students."
          kind="TEMPLATE"
          current={materials.find((m) => m.kind === 'TEMPLATE') ?? null}
          busy={busy === 'TEMPLATE'}
          disabled={disabled}
          onUpload={(f) => void upload('TEMPLATE', f)}
          onRemove={() => void remove('TEMPLATE')}
        />
        <MaterialSlot
          label="Grading Key"
          hint="Answer key or reference solution. Excel keys drive an automatic check."
          kind="KEY"
          current={materials.find((m) => m.kind === 'KEY') ?? null}
          busy={busy === 'KEY'}
          disabled={disabled}
          onUpload={(f) => void upload('KEY', f)}
          onRemove={() => void remove('KEY')}
        />
      </div>
      {error ? (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--red-600)' }}>{error}</div>
      ) : null}
    </div>
  );
}

function MaterialSlot({
  label,
  hint,
  kind,
  current,
  busy,
  disabled,
  onUpload,
  onRemove,
}: {
  label: string;
  hint: string;
  kind: 'TEMPLATE' | 'KEY';
  current: Material | null;
  busy: boolean;
  disabled: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-500)', margin: '4px 0 12px' }}>{hint}</div>
      {current ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <I.Doc w={16} h={16} stroke="var(--blue-500)" />
          <span style={{ fontSize: 13.5, flex: 1, wordBreak: 'break-all' }}>
            {current.originalFilename || current.fileName}
          </span>
          <button
            className="icon-btn"
            onClick={onRemove}
            disabled={busy || disabled}
            aria-label={`Remove ${label}`}
          >
            <I.Trash w={16} h={16} />
          </button>
        </div>
      ) : (
        <button
          className="btn btn-secondary"
          onClick={() => inputRef.current?.click()}
          disabled={busy || disabled}
        >
          <I.Download w={14} h={14} /> {busy ? 'Uploading…' : 'Upload file'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = '';
        }}
        data-kind={kind}
      />
    </div>
  );
}
