'use client';

// Ported from: C:\Devs\AIgrader\app\lti\profiles\create-profile-view.tsx
// The 4-step course AI-profile wizard (Course Context → Grading Lens →
// AI & Feedback Settings → Review & Save).
// Data flows through GET/PUT /api/courses/[courseKey]/profile; adds the
// import-from-course flow (POST {fromCourseId}) the C# app exposed.
//
// NOTE: the profile type + calibration preview below are structural CLIENT
// copies of @aigrader/shared's course-profile module — the shared package's
// runtime is server-only (node crypto/net), so the browser bundle keeps a
// local mirror. The CANONICAL renderCourseProfileText lives in
// packages/shared/src/course-profile.ts and is pinned by golden tests; this
// copy is display-only and must be kept in step with it.

import * as React from 'react';
import Link from 'next/link';
import { I } from '../_components/icons';
import { ErrorBanner } from '../_components/ui';

// ---- structural mirror of @aigrader/shared CourseSettingsProfile ----

type FeedbackLength = 'short' | 'medium' | 'long';

type CourseSettingsProfile = {
  schemaVersion: number;
  courseProfile: {
    courseLevel: string | null;
    courseType: string | null;
    genEd: boolean;
    learningOutcomes: string[];
    strongWorkDefinition: string;
    gradingPhilosophy: string;
    feedbackTone: string;
    studentAiPolicy: string;
  };
  writingExpectations: {
    grammarWeight: number;
    organizationWeight: number;
    citationWeight: number;
    clarityWeight: number;
  };
  gradingDefaults: {
    overallFeedbackLength: FeedbackLength;
    rubricFeedbackLength: FeedbackLength;
    strictness: number;
    evidenceExpectation: number;
    missingWorkPenalty: number;
    humanInTheLoop: boolean;
  };
  customPhrases: {
    vagueButClose: string;
    praiseMostOften: string;
    correctMostOften: string;
  };
  commonMistakes: string[];
  canvasOutcomes: Array<{ id: number | string; title: string; description: string }>;
  assignmentOverrides: Record<string, unknown>;
};

const DEFAULT_PROFILE: CourseSettingsProfile = {
  schemaVersion: 1,
  courseProfile: {
    courseLevel: null,
    courseType: null,
    genEd: false,
    learningOutcomes: [],
    strongWorkDefinition: '',
    gradingPhilosophy: '',
    feedbackTone: 'Encouraging and Supportive',
    studentAiPolicy: 'not_set',
  },
  writingExpectations: {
    grammarWeight: 50,
    organizationWeight: 50,
    citationWeight: 50,
    clarityWeight: 70,
  },
  gradingDefaults: {
    overallFeedbackLength: 'short',
    rubricFeedbackLength: 'short',
    strictness: 55,
    evidenceExpectation: 70,
    missingWorkPenalty: 75,
    humanInTheLoop: true,
  },
  customPhrases: { vagueButClose: '', praiseMostOften: '', correctMostOften: '' },
  commonMistakes: [],
  canvasOutcomes: [],
  assignmentOverrides: {},
};

// Ported from: C:\Devs\AIgrader\lib\canvas\course-profile.ts
// renderCourseProfileText — DISPLAY MIRROR of the pinned shared copy (see
// module note above). Only emits lines that carry signal.
function renderCourseProfileText(profile: CourseSettingsProfile): string {
  const {
    courseProfile: cp,
    gradingDefaults: gd,
    customPhrases: cph,
    writingExpectations: we,
  } = profile;
  const lines: string[] = [];

  if (cp.courseLevel) lines.push(`Course level: ${cp.courseLevel}`);
  if (cp.courseType) lines.push(`Course type: ${cp.courseType}`);
  if (cp.genEd) lines.push('This is a General Education course.');
  if (cp.gradingPhilosophy) {
    lines.push(`Grading philosophy: ${cp.gradingPhilosophy}`);
  }
  if (cp.strongWorkDefinition) {
    lines.push(`What strong work looks like: ${cp.strongWorkDefinition}`);
  }
  if (cp.feedbackTone) lines.push(`Feedback tone: ${cp.feedbackTone}`);
  lines.push(`Strictness (0 forgiving – 100 very strict): ${gd.strictness}`);
  lines.push(
    `Evidence expectation (0–100): ${gd.evidenceExpectation}; missing-work penalty (0–100): ${gd.missingWorkPenalty}`,
  );
  lines.push(
    `Overall feedback length: ${gd.overallFeedbackLength}; per-criterion feedback length: ${gd.rubricFeedbackLength}`,
  );
  lines.push(
    `Writing emphasis (0–100): grammar ${we.grammarWeight}, organization ${we.organizationWeight}, citations ${we.citationWeight}, clarity ${we.clarityWeight}`,
  );
  if (cp.studentAiPolicy && cp.studentAiPolicy !== 'not_set') {
    lines.push(`Student AI policy: ${cp.studentAiPolicy}`);
  }
  if (profile.canvasOutcomes.length > 0) {
    const MAX_PROMPT_OUTCOMES = 50;
    const shown = profile.canvasOutcomes.slice(0, MAX_PROMPT_OUTCOMES);
    lines.push('Learning outcomes (from Canvas):');
    for (const o of shown) {
      lines.push(o.description ? `- ${o.title}: ${o.description}` : `- ${o.title}`);
    }
    if (profile.canvasOutcomes.length > shown.length) {
      lines.push(`- …and ${profile.canvasOutcomes.length - shown.length} more`);
    }
  } else if (cp.learningOutcomes.length > 0) {
    lines.push('Learning outcomes:');
    for (const o of cp.learningOutcomes) lines.push(`- ${o}`);
  }
  if (cph.vagueButClose) {
    lines.push(`When work is vague but close: ${cph.vagueButClose}`);
  }
  if (cph.praiseMostOften) lines.push(`Often praises: ${cph.praiseMostOften}`);
  if (cph.correctMostOften) {
    lines.push(`Often corrects: ${cph.correctMostOften}`);
  }
  if (profile.commonMistakes.length > 0) {
    lines.push(`Common mistakes to watch for: ${profile.commonMistakes.join(', ')}`);
  }

  return lines.join('\n');
}

// Rubric/outcome alignment is managed on the dedicated Outcomes screen
// rather than duplicated as a wizard step.
const SIDEBAR_STEPS = [
  { n: 1, title: 'Course Context', sub: 'Course information and learning outcomes' },
  { n: 2, title: 'Grading Lens', sub: 'Define quality, philosophy, and feedback' },
  { n: 3, title: 'AI & Feedback Settings', sub: 'Feedback depth, behaviors, and phrases' },
  { n: 4, title: 'Review & Save', sub: 'Review your profile and save' },
];

const STUDENT_AI_POLICIES = [
  { value: 'not_set', label: 'Not specified' },
  { value: 'AI use prohibited', label: 'AI use prohibited' },
  { value: 'AI permitted with disclosure', label: 'AI permitted with disclosure' },
  { value: 'AI use encouraged', label: 'AI use encouraged' },
];

const FEEDBACK_LENGTH_OPTIONS = [
  { value: 'short', label: 'Short — a sentence or two' },
  { value: 'medium', label: 'Medium — a focused paragraph' },
  { value: 'long', label: 'Long — detailed commentary' },
] as const;

const FEEDBACK_TONES = [
  'Encouraging and Supportive',
  'Direct and Constructive',
  'Academic and Formal',
];

export function CreateProfileView({
  courseKey,
  isStaff,
}: {
  courseKey: string;
  isStaff: boolean;
}) {
  const ck = encodeURIComponent(courseKey);
  const base = `/courses/${ck}`;

  const [step, setStep] = React.useState(1);
  const [profile, setProfile] = React.useState<CourseSettingsProfile>(DEFAULT_PROFILE);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Whether this course already has a saved profile (vs. all-defaults).
  // Drives create-vs-edit framing — each course has exactly one AI profile.
  const [profileExists, setProfileExists] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/courses/${ck}/profile`);
      if (!res.ok) return;
      const body = await res.json();
      if (cancelled) return;
      if (body?.profile) setProfile(body.profile as CourseSettingsProfile);
      if (body?.exists) setProfileExists(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [ck]);

  const cp = profile.courseProfile;
  function patchCourse(patch: Partial<CourseSettingsProfile['courseProfile']>) {
    setProfile((p) => ({ ...p, courseProfile: { ...p.courseProfile, ...patch } }));
  }
  function patchDefaults(patch: Partial<CourseSettingsProfile['gradingDefaults']>) {
    setProfile((p) => ({ ...p, gradingDefaults: { ...p.gradingDefaults, ...patch } }));
  }
  function patchWriting(patch: Partial<CourseSettingsProfile['writingExpectations']>) {
    setProfile((p) => ({ ...p, writingExpectations: { ...p.writingExpectations, ...patch } }));
  }
  function patchPhrases(patch: Partial<CourseSettingsProfile['customPhrases']>) {
    setProfile((p) => ({ ...p, customPhrases: { ...p.customPhrases, ...patch } }));
  }

  async function save() {
    const missing: string[] = [];
    if (!cp.courseLevel) missing.push('Course Level');
    if (!cp.courseType) missing.push('Course Type');
    if (!cp.strongWorkDefinition.trim()) missing.push('What strong work looks like');
    if (!cp.gradingPhilosophy.trim()) missing.push('Instructor grading philosophy');
    if (missing.length > 0) {
      setError(`Please complete the required fields: ${missing.join(', ')}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${ck}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
      if (body?.profile) setProfile(body.profile as CourseSettingsProfile);
      setProfileExists(true);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="head-wrap">
      <div className="page-head">
        <div className="crumbs">
          <Link href={base}>Dashboard</Link>
          <span className="sep">/</span>
          <span className="here">{profileExists ? 'Course AI Profile' : 'Create AI Profile'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <h1 className="page-title">
              {profileExists ? 'Course AI Profile' : 'Create AI Profile'}
            </h1>
            <p className="page-sub">
              {profileExists
                ? 'This course has one AI grading profile. Edit how the AI evaluates student work below.'
                : 'Each course has one AI grading profile. Define how the AI should evaluate student work in this course.'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {savedAt ? (
              <span style={{ fontSize: 12.5, color: 'var(--green-600)' }}>Saved {savedAt}</span>
            ) : null}
            <button className="btn btn-primary" onClick={save} disabled={saving || !isStaff}>
              {saving ? 'Saving…' : profileExists ? 'Save Changes' : 'Save Profile'}
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      ) : null}

      <div className="cp-grid">
        <div>
          <div className="card" style={{ padding: 8 }}>
            {SIDEBAR_STEPS.map((s) => (
              <button
                key={s.n}
                className={'cp-step ' + (step === s.n ? 'active' : '')}
                onClick={() => setStep(s.n)}
              >
                <div
                  className={'step-num ' + (step === s.n ? 'active' : 'pending')}
                  style={{ width: 30, height: 30, fontSize: 13 }}
                >
                  {s.n}
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      color: step === s.n ? 'var(--blue-600)' : 'var(--ink-800)',
                    }}
                  >
                    {s.title}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 4, lineHeight: 1.45 }}>
                    {s.sub}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <ImportCard ck={ck} disabled={!isStaff} onImported={(p) => {
            setProfile(p);
            setProfileExists(true);
          }} />

          <div className="card" style={{ marginTop: 16, padding: 18 }}>
            <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <I.Help w={16} h={16} stroke="var(--blue-500)" /> Need help?
            </div>
            <p style={{ fontSize: 13, color: 'var(--ink-500)', margin: '8px 0' }}>
              Learn how to create an effective AI profile.
            </p>
          </div>
        </div>

        <div>
          {step === 1 && <CourseContextStep profile={profile} patchCourse={patchCourse} base={base} />}
          {step === 2 && (
            <GradingLensStep profile={profile} patchCourse={patchCourse} patchDefaults={patchDefaults} />
          )}
          {step === 3 && (
            <AiFeedbackStep
              profile={profile}
              patchCourse={patchCourse}
              patchDefaults={patchDefaults}
              patchWriting={patchWriting}
              patchPhrases={patchPhrases}
              setProfile={setProfile}
            />
          )}
          {step === 4 && <ReviewStep profile={profile} />}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
            <button
              className="btn-ghost"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              disabled={step === 1}
              style={{ fontSize: 13.5, fontWeight: 500, visibility: step === 1 ? 'hidden' : undefined }}
            >
              ← Back
            </button>
            {step < SIDEBAR_STEPS.length ? (
              <button
                className="btn btn-primary"
                onClick={() => setStep((s) => Math.min(SIDEBAR_STEPS.length, s + 1))}
              >
                Continue →
              </button>
            ) : (
              <button className="btn btn-primary" onClick={save} disabled={saving || !isStaff}>
                {saving ? 'Saving…' : profileExists ? 'Save Changes' : 'Save Profile'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Import from another course (same Canvas instance) ----

function ImportCard({
  ck,
  disabled,
  onImported,
}: {
  ck: string;
  disabled: boolean;
  onImported: (profile: CourseSettingsProfile) => void;
}) {
  const [courseIdDraft, setCourseIdDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  async function runImport() {
    const fromCourseId = Number(courseIdDraft.trim());
    if (!Number.isInteger(fromCourseId) || fromCourseId <= 0) {
      setMessage('Enter the numeric Canvas course id to copy from.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/courses/${ck}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromCourseId }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 404) {
        setMessage(`Course ${fromCourseId} has no AI profile to import.`);
        return;
      }
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      if (body?.profile) {
        onImported(body.profile as CourseSettingsProfile);
        setMessage('Profile imported. Review and save when ready.');
        setCourseIdDraft('');
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16, padding: 18 }}>
      <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
        <I.Download w={16} h={16} stroke="var(--blue-500)" /> Import from another course
      </div>
      <p style={{ fontSize: 13, color: 'var(--ink-500)', margin: '8px 0' }}>
        Copy the AI profile from another of your courses on this Canvas instance (outcome links
        stay behind — they belong to the source course).
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          placeholder="Canvas course id"
          aria-label="Source Canvas course id"
          inputMode="numeric"
          value={courseIdDraft}
          onChange={(e) => setCourseIdDraft(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn-outline-add"
          style={{ marginTop: 0 }}
          onClick={() => void runImport()}
          disabled={busy || disabled}
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
      {message ? (
        <div style={{ fontSize: 12.5, color: 'var(--ink-600)', marginTop: 8 }}>{message}</div>
      ) : null}
    </div>
  );
}

// ---- Step 1: Course Context ----

function CourseContextStep({
  profile,
  patchCourse,
  base,
}: {
  profile: CourseSettingsProfile;
  patchCourse: (p: Partial<CourseSettingsProfile['courseProfile']>) => void;
  base: string;
}) {
  const cp = profile.courseProfile;
  return (
    <div className="card">
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>1. Course Context</h2>
      <p style={{ margin: '6px 0 22px', color: 'var(--ink-500)', fontSize: 13.5 }}>
        Provide context about your course to help the AI understand what matters most.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 16, alignItems: 'end' }}>
        <div>
          <label className="lbl">
            Course Level <span className="req">*</span>
          </label>
          <select
            className="select"
            value={cp.courseLevel ?? ''}
            onChange={(e) => patchCourse({ courseLevel: e.target.value || null })}
          >
            <option value="">Select level...</option>
            <option>Introductory</option>
            <option>Intermediate</option>
            <option>Advanced</option>
          </select>
        </div>
        <div>
          <label className="lbl">
            Course Type <span className="req">*</span>
          </label>
          <select
            className="select"
            value={cp.courseType ?? ''}
            onChange={(e) => patchCourse({ courseType: e.target.value || null })}
          >
            <option value="">Select type...</option>
            <option>Major Required</option>
            <option>Elective</option>
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 10 }}>
          <button
            type="button"
            className={'toggle ' + (cp.genEd ? 'on' : '')}
            onClick={() => patchCourse({ genEd: !cp.genEd })}
            aria-pressed={cp.genEd}
            aria-label="General Education"
          >
            <span />
          </button>
          <span style={{ fontSize: 13.5 }}>General Education</span>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <label className="lbl">Learning Outcomes</label>
        <p style={{ margin: '0 0 14px', color: 'var(--ink-500)', fontSize: 12.5 }}>
          The AI grader uses your course&apos;s actual Canvas outcomes. Manage them (browse the
          library, link, or create) and align rubrics on the Outcomes &amp; Alignment screen.
        </p>
        {profile.canvasOutcomes.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {profile.canvasOutcomes.map((o) => (
              <div key={String(o.id)} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <I.Target w={16} h={16} stroke="var(--green-500)" />
                <span style={{ fontSize: 13.5 }}>{o.title}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--ink-500)' }}>
            No Canvas outcomes are linked to this course yet.
          </div>
        )}
        <Link
          href={`${base}/outcomes`}
          className="btn-outline-add"
          style={{ marginTop: 12, textDecoration: 'none' }}
        >
          <I.Target w={14} h={14} /> Manage outcomes &amp; rubric alignment
        </Link>
      </div>
    </div>
  );
}

// ---- Step 2: Grading Lens ----

function GradingLensStep({
  profile,
  patchCourse,
  patchDefaults,
}: {
  profile: CourseSettingsProfile;
  patchCourse: (p: Partial<CourseSettingsProfile['courseProfile']>) => void;
  patchDefaults: (p: Partial<CourseSettingsProfile['gradingDefaults']>) => void;
}) {
  const cp = profile.courseProfile;
  // A stored profile may carry a tone outside the preset list (e.g. the
  // schema default 'supportive_direct') — keep it selectable so nothing is
  // silently rewritten.
  const tones = FEEDBACK_TONES.includes(cp.feedbackTone)
    ? FEEDBACK_TONES
    : [cp.feedbackTone, ...FEEDBACK_TONES];
  return (
    <div className="card">
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>2. Grading Lens</h2>
      <p style={{ margin: '6px 0 22px', color: 'var(--ink-500)', fontSize: 13.5 }}>
        Define what strong work looks like and how the AI should provide feedback.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <label className="lbl">
            What strong work looks like <span className="req">*</span>
          </label>
          <p className="lbl-sub">Describe characteristics of high-quality work in this course.</p>
          <textarea
            className="textarea"
            value={cp.strongWorkDefinition}
            onChange={(e) => patchCourse({ strongWorkDefinition: e.target.value })}
            style={{ minHeight: 130 }}
          />
        </div>
        <div>
          <label className="lbl">
            Instructor grading philosophy <span className="req">*</span>
          </label>
          <p className="lbl-sub">Describe how you tend to grade when there is a judgment call.</p>
          <textarea
            className="textarea"
            value={cp.gradingPhilosophy}
            onChange={(e) => patchCourse({ gradingPhilosophy: e.target.value })}
            style={{ minHeight: 130 }}
          />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 24, alignItems: 'start' }}>
        <div>
          <label className="lbl">
            Feedback Tone <span className="req">*</span>
          </label>
          <p className="lbl-sub">Select the overall tone for AI feedback.</p>
          <div className="tone-select">
            <I.Smile w={16} h={16} stroke="var(--amber-500)" />
            <select
              className="select"
              style={{ border: 'none', paddingLeft: 8 }}
              value={cp.feedbackTone}
              onChange={(e) => patchCourse({ feedbackTone: e.target.value })}
            >
              {tones.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>
        <SliderField
          label="Strictness"
          required
          sub="Controls how quickly vague work or missing requirements reduce scores."
          value={profile.gradingDefaults.strictness}
          onChange={(v) => patchDefaults({ strictness: v })}
          legend={['Forgiving', 'Balanced', 'Very Strict']}
        />
      </div>
    </div>
  );
}

// ---- Step 3: AI & Feedback Settings ----

function AiFeedbackStep({
  profile,
  patchCourse,
  patchDefaults,
  patchWriting,
  patchPhrases,
  setProfile,
}: {
  profile: CourseSettingsProfile;
  patchCourse: (p: Partial<CourseSettingsProfile['courseProfile']>) => void;
  patchDefaults: (p: Partial<CourseSettingsProfile['gradingDefaults']>) => void;
  patchWriting: (p: Partial<CourseSettingsProfile['writingExpectations']>) => void;
  patchPhrases: (p: Partial<CourseSettingsProfile['customPhrases']>) => void;
  setProfile: React.Dispatch<React.SetStateAction<CourseSettingsProfile>>;
}) {
  const gd = profile.gradingDefaults;
  const we = profile.writingExpectations;
  const cph = profile.customPhrases;
  const [mistakeDraft, setMistakeDraft] = React.useState('');

  function addMistake() {
    const m = mistakeDraft.trim();
    if (!m) return;
    setProfile((p) =>
      p.commonMistakes.includes(m) ? p : { ...p, commonMistakes: [...p.commonMistakes, m] },
    );
    setMistakeDraft('');
  }
  function removeMistake(m: string) {
    setProfile((p) => ({ ...p, commonMistakes: p.commonMistakes.filter((x) => x !== m) }));
  }

  return (
    <>
      <div className="card">
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>3. AI &amp; Feedback Settings</h2>
        <p style={{ margin: '6px 0 22px', color: 'var(--ink-500)', fontSize: 13.5 }}>
          Tune how much feedback the AI writes and how it behaves on judgment calls.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div>
            <label className="lbl">Overall feedback length</label>
            <p className="lbl-sub">The summary comment posted with each grade.</p>
            <select
              className="select"
              value={gd.overallFeedbackLength}
              onChange={(e) =>
                patchDefaults({ overallFeedbackLength: e.target.value as FeedbackLength })
              }
            >
              {FEEDBACK_LENGTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="lbl">Per-criterion feedback length</label>
            <p className="lbl-sub">The comment written for each rubric criterion.</p>
            <select
              className="select"
              value={gd.rubricFeedbackLength}
              onChange={(e) =>
                patchDefaults({ rubricFeedbackLength: e.target.value as FeedbackLength })
              }
            >
              {FEEDBACK_LENGTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 24, alignItems: 'start' }}>
          <SliderField
            label="Evidence expectation"
            sub="How much supporting evidence student claims need before earning full credit."
            value={gd.evidenceExpectation}
            onChange={(v) => patchDefaults({ evidenceExpectation: v })}
            legend={['Lenient', 'Moderate', 'Demanding']}
          />
          <SliderField
            label="Missing-work penalty"
            sub="How strongly absent requirements (sections, citations, files) reduce scores."
            value={gd.missingWorkPenalty}
            onChange={(v) => patchDefaults({ missingWorkPenalty: v })}
            legend={['Gentle', 'Moderate', 'Severe']}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 24, alignItems: 'start' }}>
          <div>
            <label className="lbl">Student AI policy</label>
            <p className="lbl-sub">Your course policy on students using AI tools, so feedback reflects it.</p>
            <select
              className="select"
              value={profile.courseProfile.studentAiPolicy}
              onChange={(e) => patchCourse({ studentAiPolicy: e.target.value })}
            >
              {STUDENT_AI_POLICIES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="lbl">Faculty review</label>
            <p className="lbl-sub">
              Every AI draft requires your review and approval before anything posts to Canvas.
              This safeguard cannot be disabled.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="toggle on"
                disabled
                aria-pressed
                aria-label="Human-in-the-loop review (always on)"
                style={{ opacity: 0.7, cursor: 'not-allowed' }}
              >
                <span />
              </button>
              <span style={{ fontSize: 13.5 }}>Human-in-the-loop review (always on)</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 15.5, fontWeight: 600, margin: 0 }}>Writing emphasis</h3>
        <p style={{ margin: '6px 0 18px', color: 'var(--ink-500)', fontSize: 13 }}>
          How much weight writing mechanics carry when the rubric leaves room for judgment.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
          <SliderField label="Grammar & mechanics" value={we.grammarWeight} onChange={(v) => patchWriting({ grammarWeight: v })} />
          <SliderField label="Organization & structure" value={we.organizationWeight} onChange={(v) => patchWriting({ organizationWeight: v })} />
          <SliderField label="Citations & sources" value={we.citationWeight} onChange={(v) => patchWriting({ citationWeight: v })} />
          <SliderField label="Clarity of argument" value={we.clarityWeight} onChange={(v) => patchWriting({ clarityWeight: v })} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 15.5, fontWeight: 600, margin: 0 }}>Your voice</h3>
        <p style={{ margin: '6px 0 18px', color: 'var(--ink-500)', fontSize: 13 }}>
          Optional phrases and patterns so the AI&apos;s feedback sounds like yours.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div>
            <label className="lbl">When work is vague but close</label>
            <p className="lbl-sub">What you typically say when a student is almost there.</p>
            <textarea
              className="textarea"
              value={cph.vagueButClose}
              onChange={(e) => patchPhrases({ vagueButClose: e.target.value })}
              style={{ minHeight: 80 }}
            />
          </div>
          <div>
            <label className="lbl">What you praise most often</label>
            <p className="lbl-sub">Qualities you consistently call out as strengths.</p>
            <textarea
              className="textarea"
              value={cph.praiseMostOften}
              onChange={(e) => patchPhrases({ praiseMostOften: e.target.value })}
              style={{ minHeight: 80 }}
            />
          </div>
        </div>
        <div style={{ marginTop: 20 }}>
          <label className="lbl">What you correct most often</label>
          <p className="lbl-sub">Recurring issues you find yourself flagging.</p>
          <textarea
            className="textarea"
            value={cph.correctMostOften}
            onChange={(e) => patchPhrases({ correctMostOften: e.target.value })}
            style={{ minHeight: 80 }}
          />
        </div>

        <div style={{ marginTop: 24 }}>
          <label className="lbl">Common mistakes to watch for</label>
          <p className="lbl-sub">Add specific mistakes students make in this course; the AI will check for them.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input
              className="input"
              value={mistakeDraft}
              onChange={(e) => setMistakeDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addMistake();
                }
              }}
              placeholder="e.g., citing sources without analysis"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn-outline-add" onClick={addMistake}>
              <I.Plus w={14} h={14} /> Add
            </button>
          </div>
          {profile.commonMistakes.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {profile.commonMistakes.map((m) => (
                <span
                  key={m}
                  className="pill"
                  style={{
                    background: 'var(--blue-50)',
                    color: 'var(--blue-600)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {m}
                  <button
                    type="button"
                    onClick={() => removeMistake(m)}
                    aria-label={`Remove ${m}`}
                    style={{
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      color: 'inherit',
                      fontSize: 14,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ---- Step 4: Review & Save ----

function ReviewStep({ profile }: { profile: CourseSettingsProfile }) {
  const cp = profile.courseProfile;
  const gd = profile.gradingDefaults;
  const calibration = renderCourseProfileText(profile);

  return (
    <>
      <div className="card">
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>4. Review &amp; Save</h2>
        <p style={{ margin: '6px 0 22px', color: 'var(--ink-500)', fontSize: 13.5 }}>
          Confirm your profile. You can come back and adjust any of this at any time.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 24px' }}>
          <ReviewItem label="Course level" value={cp.courseLevel ?? 'Not set'} missing={!cp.courseLevel} />
          <ReviewItem label="Course type" value={cp.courseType ?? 'Not set'} missing={!cp.courseType} />
          <ReviewItem label="General Education" value={cp.genEd ? 'Yes' : 'No'} />
          <ReviewItem label="Feedback tone" value={cp.feedbackTone} />
          <ReviewItem
            label="Strong work definition"
            value={cp.strongWorkDefinition || 'Not set'}
            missing={!cp.strongWorkDefinition.trim()}
            wide
          />
          <ReviewItem
            label="Grading philosophy"
            value={cp.gradingPhilosophy || 'Not set'}
            missing={!cp.gradingPhilosophy.trim()}
            wide
          />
          <ReviewItem label="Strictness" value={`${gd.strictness} / 100`} />
          <ReviewItem label="Evidence expectation" value={`${gd.evidenceExpectation} / 100`} />
          <ReviewItem label="Missing-work penalty" value={`${gd.missingWorkPenalty} / 100`} />
          <ReviewItem
            label="Feedback length"
            value={`Overall: ${gd.overallFeedbackLength} · Per-criterion: ${gd.rubricFeedbackLength}`}
          />
          <ReviewItem
            label="Student AI policy"
            value={cp.studentAiPolicy === 'not_set' ? 'Not specified' : cp.studentAiPolicy}
          />
          <ReviewItem
            label="Canvas outcomes linked"
            value={
              profile.canvasOutcomes.length > 0
                ? `${profile.canvasOutcomes.length} outcome${profile.canvasOutcomes.length === 1 ? '' : 's'}`
                : 'None'
            }
          />
          <ReviewItem
            label="Common mistakes"
            value={profile.commonMistakes.length > 0 ? profile.commonMistakes.join('; ') : 'None'}
            wide
          />
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ fontSize: 15.5, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <I.Sparkle w={16} h={16} stroke="var(--blue-500)" /> What the AI grader will see
        </h3>
        <p style={{ margin: '6px 0 14px', color: 'var(--ink-500)', fontSize: 13 }}>
          This calibration text is added to the grading prompt for every submission in this course.
        </p>
        <pre
          style={{
            margin: 0,
            padding: 14,
            background: 'var(--ink-50, #F8FAFC)',
            border: '1px solid var(--ink-100, #E2E8F0)',
            borderRadius: 8,
            fontSize: 12.5,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            color: 'var(--ink-700, #334155)',
          }}
        >
          {calibration || 'Nothing yet — fill in the earlier steps to build the calibration.'}
        </pre>
      </div>
    </>
  );
}

function ReviewItem({
  label,
  value,
  missing,
  wide,
}: {
  label: string;
  value: string;
  missing?: boolean;
  wide?: boolean;
}) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, marginTop: 3, color: missing ? 'var(--red-600)' : 'var(--ink-800)' }}>
        {missing ? `${value} (required)` : value}
      </div>
    </div>
  );
}

// ---- Shared slider field ----

function SliderField({
  label,
  sub,
  value,
  onChange,
  legend,
  required,
}: {
  label: string;
  sub?: string;
  value: number;
  onChange: (v: number) => void;
  legend?: [string, string, string];
  required?: boolean;
}) {
  return (
    <div>
      <label className="lbl">
        {label} {required ? <span className="req">*</span> : null}
      </label>
      {sub ? <p className="lbl-sub">{sub}</p> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
          className="slider"
          style={{ flex: 1 }}
        />
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          value={value}
          aria-label={`${label} value`}
          onChange={(e) => onChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          style={{ width: 80 }}
        />
      </div>
      {legend ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-500)', marginTop: 6 }}>
          <span>{legend[0]}</span>
          <span>{legend[1]}</span>
          <span>{legend[2]}</span>
        </div>
      ) : null}
    </div>
  );
}
