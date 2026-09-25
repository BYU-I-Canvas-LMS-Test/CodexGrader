// The single point of contact with the Canvas REST API (everything except the
// Files API, which lives in files.ts). Owns auth, pagination, retry, and
// rate-limit behavior so no other module has to think about them.
//
// Ported from: C:\Devs\AIgrader\lib\canvas\client.ts (base lift: bearer auth,
// Link-header pagination, 429/5xx retry with jitter, X-Rate-Limit-Remaining
// pause, 200-with-HTML login-page detection, CanvasError shaping, bearer-host
// guard on downloads) and
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasApiClient.cs
// (functional spec: endpoint surface, ForDomain routing, gradable-items
// filter, grade/quiz passback encodings, outcomes library, rubric read/write
// incl. BuildRubricUpdateForm — pinned by RubricUpdateFormTests).
//
// Construction is dependency-injected: no env vars, no database, no
// institution lookups. Token resolution happens in the engine's credential
// provider, which passes { baseUrl, token, gate } here. Runs ONLY in the
// engine (the engine owns Canvas).
//
// Behavioral deltas from the C# client (deliberate):
//   - Failures THROW CanvasError instead of returning null/false/partial
//     lists — the engine needs real errors, and silent empties feeding the
//     document stores would be a data-loss trap. (getSubmission keeps the
//     C#-adjacent "404 → null".)
//   - The C# 401-after-redirect re-send hack is unnecessary here: undici
//     keeps the Authorization header on same-origin redirects and strips it
//     cross-origin, which is exactly the behavior that workaround emulated.

import { z } from 'zod';
import { CanvasError } from './errors.js';
import { DEFAULT_TRUSTED_SUFFIXES, isTrustedHost, normalizeHost } from './domains.js';
import { CanvasHttp, drainResponse, parsed } from './http.js';
import type { CanvasClientOptions } from './http.js';
import {
  canvasAssignmentSchema,
  canvasCourseInfoSchema,
  canvasCourseSchema,
  canvasEnrollmentSchema,
  canvasOutcomeGroupSchema,
  canvasQuizSchema,
  canvasRubricDetailSchema,
  canvasSubmissionSchema,
  canvasUserSelfSchema,
  classifyGradableItem,
  courseUserSchema,
  discussionTopicViewSchema,
  lenientNullableNumber,
  outcomeGroupLinkSchema,
  quizQuestionSchema,
  quizSubmissionAnswerSchema,
  quizSubmissionQuestionsResponseSchema,
  quizSubmissionRefSchema,
} from './types.js';
import type {
  AssignmentRubric,
  CanvasAssignment,
  CanvasCourse,
  CanvasCourseInfo,
  CanvasEnrollment,
  CanvasOutcome,
  CanvasOutcomeGroup,
  CanvasQuiz,
  CanvasSubmission,
  CanvasUserSelf,
  CourseUser,
  DiscussionEntry,
  QuizAnswerEntry,
  QuizQuestion,
  QuizSubmissionAnswer,
  QuizSubmissionRef,
} from './types.js';

// ------------------------------------------------------- rubric update form --

export type RubricRatingInput = {
  id?: string | number | null;
  description?: string | null;
  long_description?: string | null;
  points: number;
};

export type RubricCriterionInput = {
  id?: string | number | null;
  description?: string | null;
  long_description?: string | null;
  points: number;
  learning_outcome_id?: string | number | null;
  ratings?: readonly RubricRatingInput[] | null;
};

/**
 * Builds Canvas's form-encoded rubric-update parameter set
 * (`rubric[criteria][i][…]` rows plus `rubric_association_id`).
 *
 * Ported from: CanvasApiClient.cs BuildRubricUpdateForm (pinned by
 * RubricUpdateFormTests.cs). RUBRIC ID RULE: existing criterion/rating ids
 * pass through EXACTLY as received (mixed "_4692" / numeric-string forms) so
 * Canvas edits rows in place, keeping prior rubric assessments intact; empty
 * ids mark NEW rows and their id keys are OMITTED so Canvas mints fresh ones.
 * Exported so the shape is unit-testable without HTTP.
 */
export function buildRubricUpdateForm(
  title: string,
  criteria: readonly RubricCriterionInput[],
  rubricAssociationId?: number | string | null,
): Array<[string, string]> {
  const form: Array<[string, string]> = [['rubric[title]', title]];

  criteria.forEach((c, i) => {
    if (c.id != null && String(c.id) !== '') {
      form.push([`rubric[criteria][${i}][id]`, String(c.id)]);
    }
    form.push([`rubric[criteria][${i}][description]`, c.description ?? '']);
    if (c.long_description != null) {
      form.push([`rubric[criteria][${i}][long_description]`, c.long_description]);
    }
    form.push([`rubric[criteria][${i}][points]`, String(c.points)]);
    if (c.learning_outcome_id != null && String(c.learning_outcome_id) !== '') {
      form.push([`rubric[criteria][${i}][learning_outcome_id]`, String(c.learning_outcome_id)]);
    }

    (c.ratings ?? []).forEach((r, j) => {
      if (r.id != null && String(r.id) !== '') {
        form.push([`rubric[criteria][${i}][ratings][${j}][id]`, String(r.id)]);
      }
      form.push([`rubric[criteria][${i}][ratings][${j}][description]`, r.description ?? '']);
      if (r.long_description != null) {
        form.push([`rubric[criteria][${i}][ratings][${j}][long_description]`, r.long_description]);
      }
      form.push([`rubric[criteria][${i}][ratings][${j}][points]`, String(r.points)]);
    });
  });

  if (rubricAssociationId != null) {
    form.push(['rubric_association_id', String(rubricAssociationId)]);
  }
  return form;
}

// ------------------------------------------------------------------ helpers --

/**
 * Flattens a discussion topic's threaded view (top-level entries and all
 * nested replies, in API order). Callers group by user and sort.
 * Ported from: CanvasApiClient.cs Flatten.
 */
export function flattenDiscussionEntries(entries: readonly DiscussionEntry[]): DiscussionEntry[] {
  const out: DiscussionEntry[] = [];
  const walk = (list: readonly DiscussionEntry[] | null | undefined): void => {
    if (!list) return;
    for (const entry of list) {
      out.push(entry);
      walk(entry.replies);
    }
  };
  walk(entries);
  return out;
}

const gradeResultSchema = z.object({
  id: z.number().nullish(),
  score: lenientNullableNumber,
  grade: z.string().nullish(),
});

export type PostGradeArgs = {
  /** "5", 5, or "85/100" (the AI sometimes returns fractions — Canvas wants just the score). */
  postedGrade?: string | number | null;
  /**
   * Overall feedback comment. ADDITIVE in Canvas — re-posting creates a
   * duplicate. Idempotency (PostedAt) and the "[As Reviewed by {name}]"
   * prefix are the CALLER's responsibility (policy lives in the engine).
   */
  comment?: string | null;
  /**
   * Keys MUST be Canvas's exact criterion ids ("_4692" or numeric strings);
   * Canvas silently drops entries keyed any other way.
   */
  rubricAssessment?: Record<string, { points: number; comments: string }> | null;
};

type Id = string | number;

// ------------------------------------------------------------------- client --

export class CanvasClient {
  private readonly http: CanvasHttp;
  private readonly options: CanvasClientOptions;

  constructor(options: CanvasClientOptions) {
    this.http = new CanvasHttp(options);
    // Persist the resolved gate so forDomain siblings share ONE budget — all
    // instances bound to the same token share one Canvas rate bucket.
    this.options = { ...options, gate: this.http.gate };
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get gate() {
    return this.http.gate;
  }

  /**
   * Returns a client bound to another Canvas instance (multi-instance
   * Canvas-trust routing), sharing this client's token and request gate —
   * only the base URL differs. Null/empty/unsubstituted domains return this
   * client unchanged (the configured default instance).
   *
   * Throws when the domain fails the trusted-suffix check: the bearer is
   * attached to whatever base URL the client is bound to, so an unvetted
   * host must never become a request target (token-exfiltration guard).
   * Callers pinning a personal token to its own instance pass `[]`.
   *
   * Ported from: CanvasApiClient.cs ForDomain.
   */
  forDomain(apiDomain: string | null | undefined, trustedSuffixes?: readonly string[]): CanvasClient {
    const host = normalizeHost(apiDomain);
    if (host === null || host === normalizeHost(this.http.baseUrl)) return this;
    const suffixes = trustedSuffixes ?? this.options.trustedSuffixes ?? DEFAULT_TRUSTED_SUFFIXES;
    if (!isTrustedHost(host, suffixes)) {
      throw new Error(
        `Refusing to send the Canvas API token to '${host}' — it matches none of the trusted ` +
          'domain suffixes. Add the suffix if this instance is yours.',
      );
    }
    return new CanvasClient({ ...this.options, baseUrl: `https://${host}` });
  }

  // ------------------------------------------------------------ identity --

  /** GET /users/self — verifies the token and identifies its owner. */
  async getSelf(): Promise<CanvasUserSelf> {
    const path = '/api/v1/users/self';
    return parsed(canvasUserSelfSchema, await this.http.getJson(path), path);
  }

  /**
   * Courses the token holder can grade in (the personal-token course picker).
   * Canvas accepts one enrollment_type per request.
   */
  async listCourses(
    opts: { enrollmentType?: 'teacher' | 'ta' | 'designer' | 'student' | 'observer' } = {},
  ): Promise<CanvasCourse[]> {
    const path = '/api/v1/courses';
    const raw = await this.http.getPaginated(path, {
      enrollment_type: opts.enrollmentType ?? 'teacher',
      per_page: 100,
    });
    return parsed(z.array(canvasCourseSchema), raw, path);
  }

  /**
   * The CALLING user's own enrollments, across courses, via
   * GET /users/self/enrollments — works with any personal token regardless of
   * per-course permissions (unlike /courses/:id/enrollments, which 401s for
   * courses the caller cannot administer). The connect flow filters the
   * result to the target course + STAFF_ENROLLMENT_TYPES.
   */
  async getSelfEnrollments(
    opts: { state?: readonly string[]; types?: readonly string[] } = {},
  ): Promise<CanvasEnrollment[]> {
    const path = '/api/v1/users/self/enrollments';
    const raw = await this.http.getPaginated(path, {
      per_page: 100,
      ...(opts.state && opts.state.length > 0 ? { 'state[]': [...opts.state] } : {}),
      ...(opts.types && opts.types.length > 0 ? { 'type[]': [...opts.types] } : {}),
    });
    return parsed(z.array(canvasEnrollmentSchema), raw, path);
  }

  // --------------------------------------------------------- assignments --

  /** Single assignment (payload carries rubric + rubric_settings without includes). */
  async getAssignment(courseId: Id, assignmentId: Id): Promise<CanvasAssignment> {
    const path = `/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    return parsed(canvasAssignmentSchema, await this.http.getJson(path), path);
  }

  /**
   * Lists the course's gradable items (assignments, graded discussions,
   * classic quizzes) with rubrics embedded, excluding rows the AI
   * fundamentally cannot grade (not_graded, on_paper, external tools / New
   * Quizzes). Ported from: CanvasApiClient.cs GetGradableItemsAsync.
   */
  async getGradableItems(courseId: Id): Promise<CanvasAssignment[]> {
    const path = `/api/v1/courses/${courseId}/assignments`;
    const raw = await this.http.getPaginated(path, {
      per_page: 100,
      'include[]': ['rubric', 'discussion_topic'],
    });
    const all = parsed(z.array(canvasAssignmentSchema), raw, path);
    return all
      .filter((a) => a.grading_type !== 'not_graded')
      .filter((a) => classifyGradableItem(a) !== 'unsupported');
  }

  // --------------------------------------------------------- submissions --

  /** Every submission for an assignment (paginated under the hood). */
  async getSubmissions(
    courseId: Id,
    assignmentId: Id,
    opts: { include?: readonly string[] } = {},
  ): Promise<CanvasSubmission[]> {
    const path = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`;
    const raw = await this.http.getPaginated(path, {
      per_page: 100,
      ...(opts.include && opts.include.length > 0 ? { 'include[]': [...opts.include] } : {}),
    });
    return parsed(z.array(canvasSubmissionSchema), raw, path);
  }

  /**
   * ONE student's submission (used per-grade so a 100-student run doesn't
   * re-page the full list 100 times). Returns null on 404.
   */
  async getSubmission(
    courseId: Id,
    assignmentId: Id,
    userId: Id,
    opts: { include?: readonly string[] } = {},
  ): Promise<CanvasSubmission | null> {
    const url = this.http.buildUrl(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      opts.include && opts.include.length > 0 ? { 'include[]': [...opts.include] } : undefined,
    );
    const res = await this.http.send('GET', url);
    if (res.status === 404) {
      await drainResponse(res);
      return null;
    }
    if (!res.ok) {
      throw new CanvasError(res.status, url, await res.text().catch(() => ''));
    }
    return parsed(canvasSubmissionSchema, await this.http.parseJson(res, url), url);
  }

  /** Downloads bytes from a Canvas-signed URL (e.g. a submission attachment).
   * The bearer is sent ONLY when the host is Canvas; signed storage URLs
   * (S3/inst-fs) authorize themselves, and undici drops the header on any
   * cross-origin redirect hop. */
  async downloadUrl(url: string): Promise<Buffer> {
    const res = await this.http.send('GET', url);
    if (!res.ok) {
      throw new CanvasError(res.status, url, await res.text().catch(() => ''));
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------------------------------------------------------- discussions --

  /**
   * A discussion topic's full thread, flattened (top-level entries and all
   * nested replies, in API order).
   */
  async getDiscussionEntries(courseId: Id, topicId: Id): Promise<DiscussionEntry[]> {
    const path = `/api/v1/courses/${courseId}/discussion_topics/${topicId}/view`;
    const view = parsed(discussionTopicViewSchema, await this.http.getJson(path), path);
    return flattenDiscussionEntries(view.view ?? []);
  }

  // -------------------------------------------------------------- quizzes --

  /** Classic-quiz metadata (title, type, backing assignment_id, points). */
  async getQuiz(courseId: Id, quizId: Id): Promise<CanvasQuiz> {
    const path = `/api/v1/courses/${courseId}/quizzes/${quizId}`;
    return parsed(canvasQuizSchema, await this.http.getJson(path), path);
  }

  /** A classic quiz's questions (all types; callers filter to essays). */
  async getQuizQuestions(courseId: Id, quizId: Id): Promise<QuizQuestion[]> {
    const path = `/api/v1/courses/${courseId}/quizzes/${quizId}/questions`;
    const raw = await this.http.getPaginated(path, { per_page: 100 });
    return parsed(z.array(quizQuestionSchema), raw, path);
  }

  /** Every student attempt at a classic quiz (pages wrap under quiz_submissions). */
  async getQuizSubmissions(courseId: Id, quizId: Id): Promise<QuizSubmissionRef[]> {
    const path = `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions`;
    const raw = await this.http.getPaginatedWrapped(path, 'quiz_submissions', { per_page: 100 });
    return parsed(z.array(quizSubmissionRefSchema), raw, path);
  }

  /**
   * One student's per-question answers for a quiz attempt, via
   * GET /quiz_submissions/:id/questions (requires grading rights on the
   * course). Ported from: CanvasApiClient.cs GetQuizSubmissionAnswersAsync.
   */
  async getQuizSubmissionAnswers(quizSubmissionId: Id): Promise<QuizSubmissionAnswer[]> {
    const path = `/api/v1/quiz_submissions/${quizSubmissionId}/questions`;
    const wrapped = parsed(
      quizSubmissionQuestionsResponseSchema,
      await this.http.getJson(path),
      path,
    );
    return parsed(z.array(quizSubmissionAnswerSchema), wrapped.quiz_submission_questions ?? [], path);
  }

  /**
   * Alternate quiz-answer read path (the TS predecessor's confirmed route,
   * lifted from lib\canvas\client.ts getQuizSubmissionAnswers): the backing
   * assignment submission's submission_history[].submission_data, read with
   * a teacher token. When `attempt` is given, returns that attempt's entries;
   * otherwise the latest history entry that has submission_data.
   */
  async getQuizSubmissionAnswersFromHistory(
    courseId: Id,
    backingAssignmentId: Id,
    userId: Id,
    attempt?: number,
  ): Promise<QuizAnswerEntry[]> {
    const sub = await this.getSubmission(courseId, backingAssignmentId, userId, {
      include: ['submission_history'],
    });
    const history = sub?.submission_history ?? [];
    const candidates = history.filter((h) => (h.submission_data?.length ?? 0) > 0);
    const entry =
      attempt != null
        ? candidates.find((h) => h.attempt === attempt)
        : candidates[candidates.length - 1];
    return entry?.submission_data ?? [];
  }

  // --------------------------------------------------------------- roster --

  /** Students enrolled in the course (for id → name mapping / roster display). */
  async getCourseStudents(courseId: Id): Promise<CourseUser[]> {
    const path = `/api/v1/courses/${courseId}/users`;
    const raw = await this.http.getPaginated(path, {
      'enrollment_type[]': ['student'],
      'include[]': ['avatar_url'],
      per_page: 100,
    });
    return parsed(z.array(courseUserSchema), raw, path);
  }

  // ------------------------------------------------------- grade passback --

  /**
   * Posts a grade, overall comment, and optional rubric assessment to a
   * student's submission in one PUT.
   *
   * The comment side is ADDITIVE in Canvas — re-posting creates a duplicate
   * comment. Idempotency is the caller's job (the writeback service checks
   * the run document's PostedAt before ever reaching this method).
   *
   * Ported from: CanvasApiClient.cs PostGradeAsync (form encoding:
   * submission[posted_grade] + comment[text_comment] +
   * rubric_assessment[<raw id>][points|comments]).
   */
  async postGrade(
    courseId: Id,
    assignmentId: Id,
    userId: Id,
    args: PostGradeArgs,
  ): Promise<{ id: number | null; score: number | null; grade: string | null }> {
    const form: Array<[string, string]> = [];

    if (args.postedGrade != null && String(args.postedGrade).trim() !== '') {
      const raw = String(args.postedGrade);
      // The AI sometimes returns "85/100" — Canvas wants just the score.
      const posted = raw.includes('/') ? raw.split('/')[0].trim() : raw;
      form.push(['submission[posted_grade]', posted]);
    }

    if (args.comment != null && args.comment.trim() !== '') {
      form.push(['comment[text_comment]', args.comment]);
    }

    if (args.rubricAssessment) {
      // Keys MUST be Canvas's exact criterion ids ("_4692" or numeric
      // strings); Canvas silently drops entries keyed any other way.
      for (const [criterionId, value] of Object.entries(args.rubricAssessment)) {
        form.push([`rubric_assessment[${criterionId}][points]`, String(value.points)]);
        form.push([`rubric_assessment[${criterionId}][comments]`, value.comments]);
      }
    }

    const path = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`;
    const result = parsed(gradeResultSchema, await this.http.putForm(path, form), path);
    return { id: result.id ?? null, score: result.score, grade: result.grade ?? null };
  }

  /**
   * Posts per-question scores/comments for a quiz attempt in one PUT. Canvas
   * re-aggregates the quiz total itself. Unlike assignment comments, this PUT
   * is an idempotent OVERWRITE of the per-question grade — safe to retry.
   *
   * Ported from: CanvasApiClient.cs PostQuizQuestionGradesAsync (fudge_points
   * carried over from the TS client's gradeQuizSubmission).
   */
  async postQuizQuestionGrades(
    courseId: Id,
    quizId: Id,
    quizSubmissionId: Id,
    args: {
      attempt: number;
      fudgePoints?: number;
      questions: Record<string, { score?: number; comment?: string }>;
    },
  ): Promise<void> {
    const body = {
      quiz_submissions: [
        {
          attempt: args.attempt,
          ...(args.fudgePoints !== undefined ? { fudge_points: args.fudgePoints } : {}),
          questions: args.questions,
        },
      ],
    };
    await this.http.putJson(
      `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions/${quizSubmissionId}`,
      body,
    );
  }

  // ------------------------------------------------------------- outcomes --

  /** Basic course info (account ids) — locates the account whose outcome
   * library the course can draw from. */
  async getCourseInfo(courseId: Id): Promise<CanvasCourseInfo> {
    const path = `/api/v1/courses/${courseId}`;
    return parsed(canvasCourseInfoSchema, await this.http.getJson(path), path);
  }

  /** The course's root outcome group (link/create target). */
  async getCourseRootOutcomeGroup(courseId: Id): Promise<CanvasOutcomeGroup> {
    const path = `/api/v1/courses/${courseId}/root_outcome_group`;
    return parsed(canvasOutcomeGroupSchema, await this.http.getJson(path), path);
  }

  /**
   * The learning outcomes linked to a course, flat, regardless of group
   * nesting depth (deduped — the same outcome can be linked through multiple
   * groups). outcome_style=full includes descriptions.
   */
  async getCourseOutcomes(courseId: Id): Promise<CanvasOutcome[]> {
    const path = `/api/v1/courses/${courseId}/outcome_group_links`;
    const raw = await this.http.getPaginated(path, { outcome_style: 'full', per_page: 100 });
    const links = parsed(z.array(outcomeGroupLinkSchema), raw, path);
    const seen = new Set<number>();
    const out: CanvasOutcome[] = [];
    for (const link of links) {
      const outcome = link.outcome;
      if (!outcome || seen.has(outcome.id)) continue;
      seen.add(outcome.id);
      out.push(outcome);
    }
    return out;
  }

  /**
   * Creates a NEW outcome inside the course's root outcome group (which also
   * links it to the course). Throws with Canvas's message on refusal; null
   * only when Canvas omits the created outcome from its reply.
   */
  async createCourseOutcome(
    courseId: Id,
    title: string,
    description: string,
  ): Promise<CanvasOutcome | null> {
    const group = await this.getCourseRootOutcomeGroup(courseId);
    const path = `/api/v1/courses/${courseId}/outcome_groups/${group.id}/outcomes`;
    const link = parsed(
      outcomeGroupLinkSchema,
      await this.http.postForm(path, { title, description }),
      path,
    );
    return link.outcome ?? null;
  }

  /** The root outcome group of an ACCOUNT — the entry point for browsing the
   * institution's outcome library. Account groups must be addressed under
   * /accounts/:id/ — Canvas's /global/ namespace only serves site-admin
   * outcomes and 404s for account groups. */
  async getAccountRootOutcomeGroup(accountId: Id): Promise<CanvasOutcomeGroup> {
    const path = `/api/v1/accounts/${accountId}/root_outcome_group`;
    return parsed(canvasOutcomeGroupSchema, await this.http.getJson(path), path);
  }

  /** Child groups of an account outcome group — one level per call, so the
   * library tree can be expanded lazily. */
  async getAccountOutcomeSubgroups(accountId: Id, groupId: Id): Promise<CanvasOutcomeGroup[]> {
    const path = `/api/v1/accounts/${accountId}/outcome_groups/${groupId}/subgroups`;
    const raw = await this.http.getPaginated(path, { per_page: 100 });
    return parsed(z.array(canvasOutcomeGroupSchema), raw, path);
  }

  /** Outcomes directly inside an account outcome group, with descriptions. */
  async getAccountOutcomeGroupOutcomes(accountId: Id, groupId: Id): Promise<CanvasOutcome[]> {
    const path = `/api/v1/accounts/${accountId}/outcome_groups/${groupId}/outcomes`;
    const raw = await this.http.getPaginated(path, { outcome_style: 'full', per_page: 100 });
    const links = parsed(z.array(outcomeGroupLinkSchema), raw, path);
    return links.flatMap((l) => (l.outcome ? [l.outcome] : []));
  }

  /** Links an EXISTING outcome (e.g. from the account library) into the
   * course's root outcome group (PUT with an empty form body). */
  async linkOutcomeToCourse(courseId: Id, outcomeId: Id): Promise<void> {
    const group = await this.getCourseRootOutcomeGroup(courseId);
    await this.http.putForm(
      `/api/v1/courses/${courseId}/outcome_groups/${group.id}/outcomes/${outcomeId}`,
      {},
    );
  }

  /**
   * Removes every link of an outcome from the course's outcome groups (the
   * outcome can be linked through any group, root or subgroup). Canvas
   * refuses (4xx) when the outcome has already been used in an assessment —
   * that refusal is thrown with Canvas's own message so the UI can show why.
   */
  async unlinkOutcomeFromCourse(courseId: Id, outcomeId: Id): Promise<void> {
    const path = `/api/v1/courses/${courseId}/outcome_group_links`;
    const raw = await this.http.getPaginated(path, { per_page: 100 });
    const links = parsed(z.array(outcomeGroupLinkSchema), raw, path);
    const numericOutcomeId = Number(outcomeId);
    const matching = links.filter(
      (l) => l.outcome?.id === numericOutcomeId && l.outcome_group != null,
    );
    if (matching.length === 0) {
      throw new Error('That outcome is not linked to this course.');
    }
    for (const link of matching) {
      await this.http.deleteOk(
        `/api/v1/courses/${courseId}/outcome_groups/${link.outcome_group!.id}/outcomes/${outcomeId}`,
      );
    }
  }

  // -------------------------------------------------------------- rubrics --

  /**
   * Loads an assignment's rubric for editing: criteria with their EXACT
   * Canvas ids, the rubric/association ids needed to save, and whether the
   * rubric is shared by other assignments. Falls back to the assignment's
   * embedded rubric copy when the detail call fails (only the "shared across
   * N assignments" warning is lost — sharedUnknown flags it).
   *
   * Ported from: CanvasApiClient.cs GetAssignmentRubricAsync. Do NOT send
   * `style` on the rubric show endpoint — Canvas rejects it unless an
   * assessments include is requested.
   */
  async getAssignmentRubric(courseId: Id, assignmentId: Id): Promise<AssignmentRubric> {
    const assignment = await this.getAssignment(courseId, assignmentId);
    if (!assignment.rubric_settings) {
      return {
        hasRubric: false,
        rubricId: 0,
        title: '',
        criteria: [],
        rubricAssociationId: null,
        otherAssignmentCount: 0,
        shared: false,
        sharedUnknown: false,
      };
    }

    const rubricId = assignment.rubric_settings.id;
    const embedded = assignment.rubric ?? [];
    const detailPath = `/api/v1/courses/${courseId}/rubrics/${rubricId}`;
    try {
      const detail = parsed(
        canvasRubricDetailSchema,
        await this.http.getJson(detailPath, { 'include[]': ['associations'] }),
        detailPath,
      );

      const assignmentAssociations = (detail.associations ?? []).filter(
        (a) => a.association_type === 'Assignment',
      );
      const numericAssignmentId = Number(assignmentId);
      const mine = assignmentAssociations.find((a) => a.association_id === numericAssignmentId);
      const others = assignmentAssociations.filter(
        (a) => a.association_id !== numericAssignmentId,
      ).length;
      // Canvas has served criteria under `criteria` or `data` depending on
      // version; fall back to the assignment's embedded copy when both are empty.
      const criteria =
        detail.criteria && detail.criteria.length > 0
          ? detail.criteria
          : detail.data && detail.data.length > 0
            ? detail.data
            : embedded;

      return {
        hasRubric: true,
        rubricId,
        title: detail.title ?? assignment.rubric_settings.title ?? '',
        criteria,
        rubricAssociationId: mine?.id ?? null,
        otherAssignmentCount: others,
        shared: others > 0,
        sharedUnknown: false,
      };
    } catch (err) {
      if (embedded.length === 0) throw err;
      // When the detail call fails (Canvas hiccup, permission), the embedded
      // copy still lets the editor open.
      return {
        hasRubric: true,
        rubricId,
        title: assignment.rubric_settings.title ?? '',
        criteria: embedded,
        rubricAssociationId: null,
        otherAssignmentCount: 0,
        shared: false,
        sharedUnknown: true,
      };
    }
  }

  /**
   * Writes an edited rubric back to Canvas. Canvas REPLACES the criteria
   * array, so callers must pass EVERY criterion (each with its ratings) to
   * avoid dropping data. See buildRubricUpdateForm for the id round-trip rule.
   */
  async updateRubric(
    courseId: Id,
    rubricId: Id,
    args: {
      title: string;
      criteria: readonly RubricCriterionInput[];
      rubricAssociationId?: number | string | null;
    },
  ): Promise<void> {
    const form = buildRubricUpdateForm(args.title, args.criteria, args.rubricAssociationId);
    await this.http.putForm(`/api/v1/courses/${courseId}/rubrics/${rubricId}`, form);
  }
}

/**
 * Creates a CanvasClient. No env vars, no Prisma, no institution lookups —
 * token resolution happens elsewhere (the engine) and the resolved
 * { baseUrl, token, gate } are injected here.
 */
export function createCanvasClient(options: CanvasClientOptions): CanvasClient {
  return new CanvasClient(options);
}
