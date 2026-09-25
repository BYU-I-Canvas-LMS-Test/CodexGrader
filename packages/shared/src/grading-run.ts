// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Models\Storage\GradingRunDocument.cs
// (rubric snapshot shape from C:\Devs\AIGrader-C#\src\AiGrader\Models\Canvas\CanvasModels.cs)
//
// The grading-run document: one JSON file per run under "runs/" in the
// course's hidden Canvas folder ("run-a{assignmentId}-{stamp}-{runId}.json" —
// filename format is load-bearing). This is what
// makes close-browser-and-resume work with no database — the in-memory run
// state checkpoints here, and a fresh process rebuilds the run from it.
//
//   - per-student rows are EMBEDDED here (one file per run, not one row each:
//     a run resumes with one download instead of 100+ requests)
//   - student work is stored as a bounded EXCERPT only; the full submission
//     stays in Canvas and is re-fetched on demand
//
// Schema shape order matches the C# property declaration order so serialized
// output is byte-compatible with the C# app's documents.

import { z } from 'zod';
import { IsoDateTimeSchema } from './storageJson.js';

// ---------------------------------------------------------------------------
// Enums — serialized SNAKE_UPPER, the exact strings the C# JsonStringEnum-
// Converter(SnakeCaseUpper) emits (which themselves match the TS predecessor's
// Prisma enum values, e.g. "REVIEWING", "POSTED").
// ---------------------------------------------------------------------------

/** Overall status of a grading run. */
export const RUN_STATUSES = [
  'PENDING', // created, fan-out not started
  'RUNNING', // AI grading in progress
  'REVIEWING', // all drafts complete; faculty is reviewing
  'POSTING', // approved grades are posting to Canvas
  'COMPLETED', // every grade posted (or skipped) — terminal
  'FAILED', // run aborted by an unrecoverable error — terminal
  'CANCELLED', // faculty cancelled the run — terminal
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Status of one student's grade within a run. */
export const GRADE_STATUSES = [
  'PENDING', // queued, not yet picked up
  'EXTRACTING', // submission download + text extraction in progress
  'SCORING', // LLM call in progress
  'DRAFT', // AI draft ready for faculty review
  'EDITED', // faculty edited the draft
  'APPROVED', // faculty approved; queued for Canvas writeback
  'POSTED', // grade + comment landed in Canvas — terminal
  'ERROR', // grading failed for this student (visible + re-runnable in UI)
] as const;
export const GradeStatusSchema = z.enum(GRADE_STATUSES);
export type GradeStatus = z.infer<typeof GradeStatusSchema>;

/** Marks an uploaded grading material as a student template or an answer key. */
export const RESOURCE_KINDS = [
  'TEMPLATE', // the starter file students began from (boilerplate to discount)
  'KEY', // the instructor's answer key / model solution
] as const;
export const ResourceKindSchema = z.enum(RESOURCE_KINDS);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

// ---------------------------------------------------------------------------
// Rubric snapshot (Canvas API wire shape, snake_case field names — the C#
// model pins these with explicit [JsonPropertyName] attributes).
//
// IMPORTANT: criterion/rating ids vary in form — older rubrics use strings
// like "_4692", newer ones use numeric strings like "1745118159974". Canvas
// SILENTLY IGNORES rubric assessments posted with ids in the wrong form, so
// ids must round-trip exactly as received: declared as strings and never
// parsed or reformatted.
// ---------------------------------------------------------------------------

/** One selectable rating level within a rubric criterion. */
export const RubricRatingSnapshotSchema = z
  .object({
    id: z.string(),
    description: z.string().nullable().default(null),
    long_description: z.string().nullable().default(null),
    points: z.number().default(0),
  })
  .passthrough();
export type RubricRatingSnapshot = z.infer<typeof RubricRatingSnapshotSchema>;

/** One rubric criterion frozen into the run document at run start. */
export const RubricCriterionSnapshotSchema = z
  .object({
    id: z.string(),
    description: z.string().nullable().default(null),
    long_description: z.string().nullable().default(null),
    points: z.number().default(0),
    learning_outcome_id: z.number().int().nullable().default(null),
    ratings: z.array(RubricRatingSnapshotSchema).nullable().default(null),
  })
  .passthrough();
export type RubricCriterionSnapshot = z.infer<typeof RubricCriterionSnapshotSchema>;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** One rubric criterion's draft score + feedback. */
export const RubricLineDraftSchema = z
  .object({
    /** Criterion id in its EXACT Canvas form ("_4692" or "1745118159974").
     * Never coerced — Canvas silently drops mismatched forms on writeback. */
    criterionId: z.string().default(''),
    /** Selected rating id (same exact-form rule), when the rubric uses ratings. */
    ratingId: z.string().nullable().default(null),
    points: z.number().default(0),
    ratingFeedback: z.string().default(''),
  })
  .passthrough();
export type RubricLineDraft = z.infer<typeof RubricLineDraftSchema>;

/**
 * A draft grade: the AI output contract preserved from the TS predecessor
 * (lib\agents\grader\output-schema.ts) so prompts and review UI port cleanly.
 */
export const GraderDraftSchema = z
  .object({
    /** Score as "earned/possible", e.g. "18/20" (denominator stripped before Canvas passback). */
    totalPoints: z.string().default(''),
    /** Overall feedback summary (becomes the submission comment). */
    assignmentFeedback: z.string().default(''),
    rubrics: z.array(RubricLineDraftSchema).default([]),
  })
  .passthrough();
export type GraderDraft = z.infer<typeof GraderDraftSchema>;

/** Per-call LLM accounting, rolled up for run telemetry. */
export const LlmStatsSchema = z
  .object({
    inputTokens: z.number().int().default(0),
    outputTokens: z.number().int().default(0),
    latencyMs: z.number().int().default(0),
    /** Input tokens the model served from its prompt cache — optional so
     * pre-existing run documents parse unchanged. */
    cachedTokens: z.number().int().optional(),
    /** Reasoning tokens actually spent. */
    thoughtsTokens: z.number().int().optional(),
  })
  .passthrough();
export type LlmStats = z.infer<typeof LlmStatsSchema>;

/** A quiz question draft: just score + comment (port of QuizQuestionGraderOutput). */
export const QuizDraftSchema = z
  .object({
    /** Points awarded (clamped to [0, maxPoints] after parsing). */
    score: z.number().default(0),
    comment: z.string().default(''),
  })
  .passthrough();
export type QuizDraft = z.infer<typeof QuizDraftSchema>;

// ---------------------------------------------------------------------------
// Optional review-trail fields (local tool — absent in C#-written documents)
// ---------------------------------------------------------------------------
//
// COMPATIBILITY RULE: every field below is OPTIONAL and never a new enum
// value on an existing field, so documents the C# app wrote still parse and
// round-trip byte-for-byte (absent keys stay absent — the serializer omits
// undefined/null).

/** Why a row is in ERROR: the grading pass failed ('grade' → re-run it) or
 * the Canvas post failed ('post' → re-approve it; the draft is fine). */
export const ErrorKindSchema = z.enum(['grade', 'post']);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

/** Where the latest faculty edit came from. 'codex-chat' edits were made
 * through Codex at the teacher's request and are labeled in the review UI. */
export const EditSourceSchema = z.enum(['browser', 'codex-chat']);
export type EditSource = z.infer<typeof EditSourceSchema>;

/** Who approved a row, when, and through which channel. The approver's name
 * is the "[As Reviewed by {name}]" prefix source. */
export const ApproverSchema = z
  .object({
    canvasUserId: z.number().int(),
    name: z.string(),
    approvedAt: IsoDateTimeSchema,
    /** The only approval channel that exists: a click in the review page. */
    channel: z.literal('browser'),
    /** Seconds the reviewer spent on this draft before approving (audit). */
    reviewSeconds: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type Approver = z.infer<typeof ApproverSchema>;

// ---------------------------------------------------------------------------
// Per-student / per-question rows
// ---------------------------------------------------------------------------

/** One student's grading state within an assignment run. */
export const StudentGradeSchema = z
  .object({
    canvasUserId: z.number().int(),
    /** Student display name. The ONLY direct identifier stored
     * (no SIS ids, no emails) — PII minimization by design. */
    studentName: z.string().default(''),
    submissionType: z.string().nullable().default(null),
    attachmentMime: z.string().nullable().default(null),
    attachmentCount: z.number().int().default(0),
    /** Faculty-visible extraction problems from the grading pass. */
    extractionWarnings: z.array(z.string()).default([]),
    submittedAt: IsoDateTimeSchema.nullable().default(null),
    status: GradeStatusSchema.default('PENDING'),
    /** First ~2,000 chars of the extracted submission. Full text is NOT stored. */
    submissionExcerpt: z.string().nullable().default(null),
    excerptTruncated: z.boolean().default(false),
    /** The AI's draft. Never mutated after creation — faculty changes go to facultyEdited. */
    aiDraft: GraderDraftSchema.nullable().default(null),
    /** The faculty-edited version (what actually posts). Null = AI draft unedited. */
    facultyEdited: GraderDraftSchema.nullable().default(null),
    llm: LlmStatsSchema.nullable().default(null),
    errorMessage: z.string().nullable().default(null),
    /** When the grade landed in Canvas. THE idempotency marker: writeback
     * refuses to post anything that already has this set. */
    postedAt: IsoDateTimeSchema.nullable().default(null),
    updatedAt: IsoDateTimeSchema,
    /** LEGACY (never written by this app): a page count some earlier builds
     * recorded per student. Kept optional so those run documents still
     * parse; nothing reads it. */
    pagesCharged: z.number().int().nonnegative().optional(),
    /** Local tool: which failure put the row in ERROR (see ErrorKindSchema). */
    errorKind: ErrorKindSchema.optional(),
    /** Local tool: who approved the row (the comment-prefix name source). */
    approvedBy: ApproverSchema.optional(),
    /** Local tool: where the latest faculty edit came from. */
    editSource: EditSourceSchema.optional(),
    /** Local tool: true when facultyEdited predates the current AI draft (the
     * row was re-run after being edited) — the reviewer keeps or discards it. */
    staleEdit: z.boolean().optional(),
  })
  .passthrough();
export type StudentGrade = z.infer<typeof StudentGradeSchema>;

/** One (student attempt × essay question) grading state within a quiz run. */
export const QuizQuestionGradeEntrySchema = z
  .object({
    canvasUserId: z.number().int(),
    studentName: z.string().default(''),
    /** The quiz submission (attempt container) id. */
    quizSubmissionId: z.number().int(),
    /** Attempt number — required by the per-question grading PUT. */
    attempt: z.number().int().default(0),
    questionId: z.number().int(),
    questionName: z.string().default(''),
    /** Maximum points for the question (the score clamp ceiling). */
    maxPoints: z.number().default(0),
    status: GradeStatusSchema.default('PENDING'),
    /** Bounded excerpt of the student's essay answer. */
    answerExcerpt: z.string().nullable().default(null),
    aiDraft: QuizDraftSchema.nullable().default(null),
    facultyEdited: QuizDraftSchema.nullable().default(null),
    errorMessage: z.string().nullable().default(null),
    /** Quiz PUTs are idempotent overwrites (unlike assignment comments), so
     * retry-after-failure is safe; this marker still prevents re-posting. */
    postedAt: IsoDateTimeSchema.nullable().default(null),
    updatedAt: IsoDateTimeSchema,
    /** Local tool: which failure put the row in ERROR (see ErrorKindSchema). */
    errorKind: ErrorKindSchema.optional(),
    /** Local tool: who approved the row (the comment-prefix name source). */
    approvedBy: ApproverSchema.optional(),
    /** Local tool: where the latest faculty edit came from. */
    editSource: EditSourceSchema.optional(),
    /** Local tool: true when facultyEdited predates the current AI draft (the
     * row was re-run after being edited) — the reviewer keeps or discards it. */
    staleEdit: z.boolean().optional(),
  })
  .passthrough();
export type QuizQuestionGradeEntry = z.infer<typeof QuizQuestionGradeEntrySchema>;

/** One essay question frozen at quiz-run start (the prompt's inputs). */
export const QuizQuestionSnapshotSchema = z
  .object({
    questionId: z.number().int(),
    questionName: z.string().default(''),
    /** Question prompt as HTML (stripped at prompt-build time). */
    questionTextHtml: z.string().default(''),
    maxPoints: z.number().default(0),
    /** Author's "correct answer" guidance, when provided. */
    correctComments: z.string().nullable().default(null),
    /** Author's general guidance, when provided. */
    neutralComments: z.string().nullable().default(null),
  })
  .passthrough();
export type QuizQuestionSnapshot = z.infer<typeof QuizQuestionSnapshotSchema>;

/**
 * ADVISORY lock written into the run document. Not a real mutex — Canvas
 * files can't provide one. Its only job is the "this run appears open
 * elsewhere — take over?" signal when a second laptop/process opens a run
 * whose heartbeat is fresh.
 */
export const RunLockSchema = z
  .object({
    /** Owning instance, formatted "MACHINENAME:instanceGuid". */
    owner: z.string().default(''),
    /** Display name of the teacher whose session owns the run. */
    ownerName: z.string().default(''),
    /** Refreshed on every checkpoint; stale (>2 min) means the owner is gone. */
    heartbeatUtc: IsoDateTimeSchema,
  })
  .passthrough();
export type RunLock = z.infer<typeof RunLockSchema>;

/** What a run grades WITH, frozen at run start so a mid-run edit to the
 * prep settings or the course AI profile can't change later drafts (and a
 * resume grades with the same inputs). Local tool; absent in C# documents,
 * which fall back to live reads. */
export const PrepSnapshotSchema = z
  .object({
    customInstructions: z.string().default(''),
    shareRubric: z.boolean().default(true),
    shareInstructions: z.boolean().default(true),
    /** renderCourseProfileText(profile) at run start. */
    profileText: z.string().default(''),
  })
  .passthrough();
export type PrepSnapshot = z.infer<typeof PrepSnapshotSchema>;

/** Why a run is paused (grading stopped, nothing lost; resume continues). */
export const PauseReasonSchema = z.enum(['usage_limit', 'codex_auth', 'canvas_auth']);
export type PauseReason = z.infer<typeof PauseReasonSchema>;

// ---------------------------------------------------------------------------
// Root document
// ---------------------------------------------------------------------------

/** Root of a run document (runs/run-a{assignmentId}-{stamp}-{runId8}.json). */
export const GradingRunDocumentSchema = z
  .object({
    /** Document schema version for forward migration. */
    schemaVersion: z.number().int().default(1),
    /** Run id (GUID "N" format). Also embedded in the filename. */
    runId: z.string().default(''),
    /** Course fingerprint — a mismatch after a Canvas course copy marks the
     * document an orphan so one course's student data never surfaces in another. */
    canvasCourseId: z.number().int(),
    /** Host of the Canvas instance the course lives on (e.g.
     * "byupw.instructure.com"). Null/empty = the configured default instance.
     * Routes EVERY Canvas call the run makes across restarts and resumes. */
    canvasApiDomain: z.string().nullable().default(null),
    canvasAssignmentId: z.number().int(),
    /** Set for classic-quiz runs; null for regular assignments. When set,
     * quizGrades is the active collection instead of grades. */
    canvasQuizId: z.number().int().nullable().default(null),
    /** Set for graded-discussion runs: the discussion topic whose posts are
     * aggregated per student as the "submission". */
    canvasDiscussionTopicId: z.number().int().nullable().default(null),
    /** Quiz runs: the essay questions frozen at run start. */
    quizQuestionSnapshot: z.array(QuizQuestionSnapshotSchema).default([]),
    /** Assignment name at run time (display only). */
    assignmentName: z.string().default(''),
    pointsPossible: z.number().nullable().default(null),
    /** The assignment instructions (Canvas HTML) frozen at run start. */
    assignmentDescriptionHtml: z.string().nullable().default(null),
    /** The rubric FROZEN at run start, so a mid-run rubric edit in Canvas
     * can't make criterion ids stop matching. */
    rubricSnapshot: z.array(RubricCriterionSnapshotSchema).default([]),
    /** The model that produced the drafts (telemetry/troubleshooting). */
    modelName: z.string().default(''),
    /** The reasoning effort ("low" | "medium" | "high") used for the drafts. */
    reasoningEffort: z.string().default(''),
    /** Faculty's one-off style/instruction notes for this run. */
    additionalInstructions: z.string().nullable().default(null),
    facultyCanvasUserId: z.number().int().default(0),
    /** Faculty display name — used in the "[As Reviewed by X]" comment prefix. */
    facultyName: z.string().default(''),
    status: RunStatusSchema.default('PENDING'),
    totalCount: z.number().int().default(0),
    /** Items that reached DRAFT or beyond. */
    completedCount: z.number().int().default(0),
    errorCount: z.number().int().default(0),
    createdAt: IsoDateTimeSchema,
    startedAt: IsoDateTimeSchema.nullable().default(null),
    finishedAt: IsoDateTimeSchema.nullable().default(null),
    updatedAt: IsoDateTimeSchema,
    lock: RunLockSchema.nullable().default(null),
    /** Per-student grades (assignment runs). */
    grades: z.array(StudentGradeSchema).default([]),
    /** Per-question grades (quiz runs). */
    quizGrades: z.array(QuizQuestionGradeEntrySchema).default([]),
    /** Local tool: the prep + profile inputs frozen at run start. */
    prepSnapshot: PrepSnapshotSchema.optional(),
    /** Local tool: set while grading is paused (usage limit / sign-in). */
    pausedReason: PauseReasonSchema.optional(),
    /** Local tool: when a usage-limit pause lifts (ISO), if known. */
    pausedUntil: IsoDateTimeSchema.optional(),
    /** Local tool: faculty-readable pause explanation + fix. */
    pausedMessage: z.string().optional(),
    /** Local tool: which build wrote the document (troubleshooting). */
    generator: z.string().optional(),
  })
  .passthrough();
export type GradingRunDocument = z.infer<typeof GradingRunDocumentSchema>;
