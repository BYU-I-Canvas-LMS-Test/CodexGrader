// Canvas REST DTOs as zod schemas with LENIENT parsing.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Models\Canvas\CanvasModels.cs
// and C:\Devs\AIGrader-C#\src\AiGrader\Models\Canvas\LenientNullableIntConverter.cs
// (tolerance pinned by tests\AiGrader.Tests\QuizDtoToleranceTests.cs);
// shapes cross-checked against C:\Devs\AIgrader\lib\canvas\client.ts.
//
// Only fields the app actually uses are declared (extra keys are stripped),
// and numeric fields Canvas is known to drift on (quiz position/attempt,
// points) tolerate null / string / decimal spellings — a strict DTO turns
// that drift into a failed grading run.
//
// RUBRIC ID RULE (load-bearing): criterion/rating ids vary in form — older
// rubrics use strings like "_4692", newer ones numeric strings like
// "1745118159974". Canvas SILENTLY IGNORES rubric assessments posted with ids
// in the wrong form, so ids are strings end-to-end and must round-trip
// exactly as received; they are never parsed or reformatted.

import { z } from 'zod';

// ---------------------------------------------------------------- leniency --

function coerceLenientNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // Objects/arrays/booleans carry no usable number — treat as absent rather
  // than failing the whole response (LenientNullableIntConverter behavior).
  return null;
}

/** Nullable number tolerant of Canvas's number spellings (null/string/decimal). */
export const lenientNullableNumber = z.preprocess(coerceLenientNumber, z.number().nullable());

/**
 * Nullable int tolerant of Canvas's number spellings. Port of
 * LenientNullableIntConverter (decimal spellings round; JS Math.round differs
 * from .NET's banker's rounding only at exact midpoints, which Canvas does
 * not emit for these fields).
 */
export const lenientNullableInt = z.preprocess((v) => {
  const n = coerceLenientNumber(v);
  return n === null ? null : Math.round(n);
}, z.number().int().nullable());

/** Number that degrades to 0 when absent/unparseable (C# non-nullable double default). */
export const lenientNumberOrZero = z.preprocess((v) => coerceLenientNumber(v) ?? 0, z.number());

/**
 * A Canvas rubric criterion/rating id in its EXACT raw form. Numbers are
 * stringified (JSON numeric ids are integers well under 2^53, so the digits
 * are preserved verbatim); absent ids become '' (the "new row" marker).
 */
export const rawCanvasId = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null ? '' : String(v)));

// -------------------------------------------------------------- rubric DTOs --

export const canvasRubricRatingSchema = z.object({
  id: rawCanvasId,
  description: z.string().nullish(),
  long_description: z.string().nullish(),
  points: lenientNumberOrZero,
});
export type CanvasRubricRating = z.infer<typeof canvasRubricRatingSchema>;

export const canvasRubricCriterionSchema = z.object({
  id: rawCanvasId,
  description: z.string().nullish(),
  long_description: z.string().nullish(),
  points: lenientNumberOrZero,
  /** The Canvas learning outcome this criterion measures, when linked. */
  learning_outcome_id: z.union([z.string(), z.number()]).nullish(),
  ratings: z.array(canvasRubricRatingSchema).nullish(),
});
export type CanvasRubricCriterion = z.infer<typeof canvasRubricCriterionSchema>;

/** Rubric attachment metadata embedded on an assignment row (the rubric id). */
export const rubricSettingsRefSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  points_possible: lenientNullableNumber,
});
export type RubricSettingsRef = z.infer<typeof rubricSettingsRefSchema>;

/** One rubric ↔ assignment/course association row (include[]=associations). */
export const canvasRubricAssociationSchema = z.object({
  id: z.number(),
  association_type: z.string().nullish(), // 'Assignment' | 'Course'
  association_id: z.number().nullish(),
});
export type CanvasRubricAssociation = z.infer<typeof canvasRubricAssociationSchema>;

/**
 * The rubric "show" payload. Canvas has historically served the criteria
 * under either `criteria` or `data` depending on version/serializer, so both
 * are declared and the client picks whichever is populated.
 */
export const canvasRubricDetailSchema = z.object({
  id: z.number().nullish(),
  title: z.string().nullish(),
  criteria: z.array(canvasRubricCriterionSchema).nullish(),
  data: z.array(canvasRubricCriterionSchema).nullish(),
  associations: z.array(canvasRubricAssociationSchema).nullish(),
});
export type CanvasRubricDetail = z.infer<typeof canvasRubricDetailSchema>;

/**
 * An assignment's rubric loaded for editing: criteria with their EXACT Canvas
 * ids, plus the facts needed to PUT it back and to warn about shared rubrics.
 * Composed by CanvasClient.getAssignmentRubric (port of C# AssignmentRubric).
 */
export type AssignmentRubric = {
  /** False when the assignment has no rubric attached (nothing else is populated). */
  hasRubric: boolean;
  /** The rubric's Canvas id (PUT target). */
  rubricId: number;
  title: string;
  /** Criteria with ids exactly as Canvas returned them (round-trip rule). */
  criteria: CanvasRubricCriterion[];
  /** This assignment's rubric-association id; null when undiscoverable (the PUT still works). */
  rubricAssociationId: number | null;
  /** How many OTHER assignments share this rubric. */
  otherAssignmentCount: number;
  /** True when at least one other assignment uses this rubric — editing changes them all. */
  shared: boolean;
  /** True when the associations lookup failed and sharing could not be determined. */
  sharedUnknown: boolean;
};

// ---------------------------------------------------------- assignment DTOs --

/** Minimal reference to a discussion topic embedded in an assignment row. */
export const discussionTopicRefSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
});
export type DiscussionTopicRef = z.infer<typeof discussionTopicRefSchema>;

/** A Canvas assignment as returned by GET /courses/:id/assignments (with rubric included). */
export const canvasAssignmentSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  /** Assignment instructions as HTML (Canvas rich content). */
  description: z.string().nullish(),
  submission_types: z.array(z.string()).nullish(),
  points_possible: lenientNullableNumber,
  due_at: z.string().nullish(),
  /** Omitted by Canvas for callers without grading rights; treat null as 0. */
  needs_grading_count: lenientNullableInt,
  has_submitted_submissions: z.boolean().nullish(),
  published: z.boolean().nullish(),
  /** points, percent, letter_grade, not_graded, … */
  grading_type: z.string().nullish(),
  /** For quiz-backed items, the classic-quiz id used by the quiz APIs. */
  quiz_id: z.number().nullish(),
  discussion_topic: discussionTopicRefSchema.nullish(),
  /** The attached rubric's criteria, when include[]=rubric was requested. */
  rubric: z.array(canvasRubricCriterionSchema).nullish(),
  rubric_settings: rubricSettingsRefSchema.nullish(),
});
export type CanvasAssignment = z.infer<typeof canvasAssignmentSchema>;

/**
 * How a Canvas gradable item is classified for grading purposes. Canvas's
 * gradebook is a flat list of "assignments", but submission_types reveals
 * whether an item is really a discussion or a classic quiz.
 */
export type GradableItemKind = 'assignment' | 'discussion' | 'quiz' | 'unsupported';

/**
 * Port of C# CanvasAssignment.ItemType. 'quiz' means a CLASSIC quiz
 * (online_quiz); New Quizzes launch as external_tool assignments and classify
 * as 'unsupported' (their API does not expose essay responses for grading).
 */
export function classifyGradableItem(
  item: Pick<CanvasAssignment, 'submission_types'>,
): GradableItemKind {
  const st = item.submission_types;
  if (!st || st.length === 0) return 'unsupported';
  if (st.includes('online_quiz')) return 'quiz';
  if (st.includes('discussion_topic')) return 'discussion';
  if (st.some((t) => t === 'online_upload' || t === 'online_text_entry' || t === 'online_url')) {
    return 'assignment';
  }
  return 'unsupported';
}

/**
 * Which workload section an assignment falls into on the faculty assignments
 * page (port of C# CanvasAssignment.Bucket). Derived from submission/grading
 * counts, not the due date: submitted work waiting is always ready_to_grade;
 * otherwise anything ever submitted is past; a past-due assignment nobody
 * submitted to stays upcoming — there is genuinely nothing to grade.
 */
export type GradingBucket = 'ready_to_grade' | 'upcoming' | 'past';

export function gradingBucket(
  item: Pick<CanvasAssignment, 'needs_grading_count' | 'has_submitted_submissions'>,
): GradingBucket {
  if ((item.needs_grading_count ?? 0) > 0) return 'ready_to_grade';
  return item.has_submitted_submissions ? 'past' : 'upcoming';
}

// ---------------------------------------------------------- discussion DTOs --

/** One entry in a discussion thread; replies nest recursively. */
export type DiscussionEntry = {
  id: number;
  user_id?: number | null;
  parent_id?: number | null;
  created_at?: string | null;
  /** Post body as HTML. */
  message?: string | null;
  replies?: DiscussionEntry[] | null;
};

export const discussionEntrySchema: z.ZodType<DiscussionEntry> = z.lazy(() =>
  z.object({
    id: z.number(),
    user_id: z.number().nullish(),
    parent_id: z.number().nullish(),
    created_at: z.string().nullish(),
    message: z.string().nullish(),
    replies: z.array(discussionEntrySchema).nullish(),
  }),
);

/** Response wrapper for GET /discussion_topics/:id/view. */
export const discussionTopicViewSchema = z.object({
  view: z.array(discussionEntrySchema).nullish(),
});
export type DiscussionTopicView = z.infer<typeof discussionTopicViewSchema>;

// ---------------------------------------------------------------- quiz DTOs --

/** Classic-quiz metadata (title, type, backing assignment_id, points). */
export const canvasQuizSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  /** 'assignment' | 'practice_quiz' | 'graded_survey' | 'survey' */
  quiz_type: z.string().nullish(),
  assignment_id: z.number().nullish(),
  points_possible: lenientNullableNumber,
  question_count: lenientNullableInt,
  published: z.boolean().nullish(),
  description: z.string().nullish(),
});
export type CanvasQuiz = z.infer<typeof canvasQuizSchema>;

/**
 * A classic-quiz question. New Quizzes use a different LTI-based API and are
 * intentionally unsupported (they don't appear via these endpoints).
 */
export const quizQuestionSchema = z.object({
  id: z.number(),
  /** Null when Canvas serves the question without one (e.g. question groups). */
  position: lenientNullableInt,
  /** Only 'essay_question' is AI-gradable. */
  question_type: z.string().nullish(),
  question_name: z.string().nullish(),
  /** The question prompt as HTML. */
  question_text: z.string().nullish(),
  points_possible: lenientNullableNumber,
  /** Author's "what a correct answer looks like" — AI grading guidance when present. */
  correct_comments: z.string().nullish(),
  neutral_comments: z.string().nullish(),
});
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

/** Question types the AI grader handles per-question (Canvas auto-scores the rest). */
export const AI_GRADABLE_QUIZ_QUESTION_TYPES = ['essay_question'] as const;

export function isAiGradableQuizQuestion(q: Pick<QuizQuestion, 'question_type'>): boolean {
  return (AI_GRADABLE_QUIZ_QUESTION_TYPES as readonly string[]).includes(q.question_type ?? '');
}

/** A student's attempt at a quiz (one row per submission). */
export const quizSubmissionRefSchema = z.object({
  /** Quiz submission id (NOT the same as the assignment submission id). */
  id: z.number(),
  user_id: z.number().nullish(),
  /** Required when posting per-question grades. Null on untaken submissions. */
  attempt: lenientNullableInt,
  submitted_at: z.string().nullish(),
  /** untaken, complete, pending_review, … */
  workflow_state: z.string().nullish(),
});
export type QuizSubmissionRef = z.infer<typeof quizSubmissionRefSchema>;

/** Wrapper: the quiz submissions endpoint nests results under quiz_submissions. */
export const quizSubmissionsListResponseSchema = z.object({
  quiz_submissions: z.array(quizSubmissionRefSchema).nullish(),
});

/** A single answer within a quiz submission (essay answers carry text). */
export const quizSubmissionAnswerSchema = z.object({
  /** The QUESTION id this answer belongs to (Canvas reuses "id" here). */
  id: z.number(),
  /** Raw because the shape varies by question type — string for essays, arrays/objects elsewhere. */
  answer: z.unknown(),
});
export type QuizSubmissionAnswer = z.infer<typeof quizSubmissionAnswerSchema>;

/** Wrapper: per-submission answers nest under quiz_submission_questions. */
export const quizSubmissionQuestionsResponseSchema = z.object({
  quiz_submission_questions: z.array(quizSubmissionAnswerSchema).nullish(),
});

/**
 * One entry of submission_history[].submission_data (the TS predecessor's
 * confirmed quiz-answer read path). For essay questions `text` is the
 * student's full answer and `correct` is the string "undefined" (ungraded) /
 * "defined" (graded); objective types carry boolean `correct` + answer_id.
 */
export const quizAnswerEntrySchema = z.object({
  question_id: z.number(),
  points: lenientNullableNumber,
  correct: z.union([z.boolean(), z.string()]).nullish(),
  text: z.string().nullish(),
  answer_id: z.number().nullish(),
  more_comments: z.string().nullish(),
});
export type QuizAnswerEntry = z.infer<typeof quizAnswerEntrySchema>;

// ---------------------------------------------------------- submission DTOs --

/** A file attached to a submission. */
export const canvasAttachmentSchema = z.object({
  id: z.number(),
  /** Original filename (its extension drives text-extraction routing). */
  filename: z.string().nullish(),
  display_name: z.string().nullish(),
  size: lenientNullableNumber,
  /** Canvas returns this with a hyphen. Often octet-stream for code files; trust the extension. */
  'content-type': z.string().nullish(),
  mime_class: z.string().nullish(),
  /** Signed download URL. SHORT-LIVED — use promptly, never persist. */
  url: z.string().nullish(),
  preview_url: z.string().nullish(),
});
export type CanvasAttachment = z.infer<typeof canvasAttachmentSchema>;

/** One submission_history entry (include[]=submission_history). */
export const submissionHistoryEntrySchema = z.object({
  attempt: lenientNullableInt,
  submission_type: z.string().nullish(),
  workflow_state: z.string().nullish(),
  body: z.string().nullish(),
  url: z.string().nullish(),
  submitted_at: z.string().nullish(),
  attachments: z.array(canvasAttachmentSchema).nullish(),
  /** Per-question answers for online_quiz submissions. */
  submission_data: z.array(quizAnswerEntrySchema).nullish(),
});
export type SubmissionHistoryEntry = z.infer<typeof submissionHistoryEntrySchema>;

/** One submission comment (include[]=submission_comments). The writeback's
 * pre-post check reads these to avoid posting a duplicate comment. */
export const submissionCommentSchema = z.object({
  id: z.number().nullish(),
  author_id: z.number().nullish(),
  comment: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type SubmissionComment = z.infer<typeof submissionCommentSchema>;

/** A student's submission to an assignment. */
export const canvasSubmissionSchema = z.object({
  id: z.number().nullish(),
  user_id: z.number(),
  assignment_id: z.number().nullish(),
  attempt: lenientNullableInt,
  /** unsubmitted, submitted, graded, pending_review */
  workflow_state: z.string().nullish(),
  late: z.boolean().nullish(),
  seconds_late: lenientNullableNumber,
  attachments: z.array(canvasAttachmentSchema).nullish(),
  /** Student text for online_text_entry submissions, as HTML. */
  body: z.string().nullish(),
  /** The submitted URL for online_url submissions. */
  url: z.string().nullish(),
  /** The type the student actually used for THIS submission. */
  submission_type: z.string().nullish(),
  submitted_at: z.string().nullish(),
  /** Current posted score (used to reconcile run state against Canvas). */
  score: lenientNullableNumber,
  graded_at: z.string().nullish(),
  submission_history: z.array(submissionHistoryEntrySchema).nullish(),
  submission_comments: z.array(submissionCommentSchema).nullish(),
});
export type CanvasSubmission = z.infer<typeof canvasSubmissionSchema>;

/** True when the submission carries at least one file attachment (C# HasFileAttachment). */
export function hasFileAttachment(sub: Pick<CanvasSubmission, 'attachments'>): boolean {
  return (sub.attachments?.length ?? 0) > 0;
}

/** True when the submission carries non-empty entered text (C# HasTextBody). */
export function hasTextBody(sub: Pick<CanvasSubmission, 'body'>): boolean {
  return typeof sub.body === 'string' && sub.body.trim() !== '';
}

/** Days late, rounded to one decimal (C# DaysLate). */
export function daysLate(sub: Pick<CanvasSubmission, 'seconds_late'>): number {
  const seconds = sub.seconds_late ?? 0;
  return seconds > 0 ? Math.round((seconds / 86400) * 10) / 10 : 0;
}

// --------------------------------------------------- roster / course / user --

/** A course enrollee (used to map user ids to display names). */
export const courseUserSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  /** "Last, First" sortable form used for roster ordering. */
  sortable_name: z.string().nullish(),
  short_name: z.string().nullish(),
  avatar_url: z.string().nullish(),
});
export type CourseUser = z.infer<typeof courseUserSchema>;

/** Basic course info — locates the account whose outcome library the course can draw from. */
export const canvasCourseInfoSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  account_id: z.number().nullish(),
  root_account_id: z.number().nullish(),
});
export type CanvasCourseInfo = z.infer<typeof canvasCourseInfoSchema>;

/**
 * A course row from GET /api/v1/courses (the personal-token course picker).
 * Not in the C# app (it was LTI-launched); needed for the PAT connect flow.
 */
export const canvasCourseSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  course_code: z.string().nullish(),
  workflow_state: z.string().nullish(),
  account_id: z.number().nullish(),
});
export type CanvasCourse = z.infer<typeof canvasCourseSchema>;

/**
 * One enrollment row from GET /api/v1/users/self/enrollments (the calling
 * user's own enrollments). Not in the C# app (it was LTI-launched; roles came
 * from the launch); needed by the PAT connect flow to verify the caller
 * really holds a teacher/ta/designer seat in a course before linking it.
 */
export const canvasEnrollmentSchema = z.object({
  id: z.number(),
  course_id: z.number().nullish(),
  user_id: z.number().nullish(),
  /** 'TeacherEnrollment' | 'TaEnrollment' | 'DesignerEnrollment' | 'StudentEnrollment' | … */
  type: z.string().nullish(),
  role: z.string().nullish(),
  /** 'active' | 'invited' | 'inactive' | 'completed' | … */
  enrollment_state: z.string().nullish(),
});
export type CanvasEnrollment = z.infer<typeof canvasEnrollmentSchema>;

/** Enrollment `type` values that count as course staff for grading purposes,
 * mapped to the short role names the app stores (plan: "PAT is the authority;
 * app offers only enrollment_type=teacher|ta|designer courses"). */
export const STAFF_ENROLLMENT_TYPES: Readonly<Record<string, 'teacher' | 'ta' | 'designer'>> = {
  TeacherEnrollment: 'teacher',
  TaEnrollment: 'ta',
  DesignerEnrollment: 'designer',
};

/** GET /api/v1/users/self — token verification / identity probe. */
export const canvasUserSelfSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  primary_email: z.string().nullish(),
  login_id: z.string().nullish(),
  avatar_url: z.string().nullish(),
});
export type CanvasUserSelf = z.infer<typeof canvasUserSelfSchema>;

// -------------------------------------------------------------- outcome DTOs --

/** A Canvas learning outcome attached to the course. */
export const canvasOutcomeSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  /** Outcome description as HTML. */
  description: z.string().nullish(),
});
export type CanvasOutcome = z.infer<typeof canvasOutcomeSchema>;

/** An outcome group node (course or account context) in Canvas's outcome tree. */
export const canvasOutcomeGroupSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
});
export type CanvasOutcomeGroup = z.infer<typeof canvasOutcomeGroupSchema>;

/** Wire shape: an outcome group link wrapping its outcome (and the group it lives in). */
export const outcomeGroupLinkSchema = z.object({
  outcome: canvasOutcomeSchema.nullish(),
  outcome_group: canvasOutcomeGroupSchema.nullish(),
});
export type OutcomeGroupLink = z.infer<typeof outcomeGroupLinkSchema>;

// ----------------------------------------------------------------- file DTOs --

/** Wire shape of a Canvas file object (Files API + upload confirmations). */
export const canvasFileSchema = z.object({
  id: z.number(),
  filename: z.string().nullish(),
  display_name: z.string().nullish(),
  size: lenientNullableNumber,
  'content-type': z.string().nullish(),
  updated_at: z.string().nullish(),
  /** Signed download URL. SHORT-LIVED — use immediately, never persist. */
  url: z.string().nullish(),
});
export type CanvasFileDto = z.infer<typeof canvasFileSchema>;

/** Wire shape of a Canvas folder object. */
export const canvasFolderSchema = z.object({
  id: z.number(),
  name: z.string().nullish(),
  parent_folder_id: z.number().nullish(),
});
export type CanvasFolderDto = z.infer<typeof canvasFolderSchema>;

/** Step-1 response of Canvas's 2-step file upload. */
export const uploadInitSchema = z.object({
  upload_url: z.string(),
  upload_params: z.record(z.unknown()).nullish(),
});
export type UploadInit = z.infer<typeof uploadInitSchema>;
