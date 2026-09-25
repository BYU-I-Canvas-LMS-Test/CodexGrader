// Course service endpoints for the local UI and MCP tools — mounted at
// /course on the in-process engine app. The engine owns every Canvas API
// call; apps/web only relays. Every body carries {apiDomain?, courseId}; the
// teacher's token never travels in a request.
//
//   POST /course/assignments       → gradable items, bucketed + sorted for the
//                                    faculty assignments page
//   POST /course/assignment/detail {…, assignmentId} → assignment + rubric
//                                    snapshot + submission counts (+ quiz info)
//   POST /course/profile/get      → ProfileStore.get (never-null) + exists
//   POST /course/profile/save     {…, profile}      → validate + save
//   POST /course/profile/import   {…, fromCourseId} → copy another course's
//                                    profile (outcomes stripped)
//   POST /course/resources/get    {…, assignmentId} → prep settings + entries
//   POST /course/resources/prep   {…, assignmentId, prep} → save prep
//   POST /course/resources/upload {…, assignmentId, kind, filename,
//                                  contentType, bytesBase64 ≤ 15 MB} → store
//   POST /course/resources/delete {…, assignmentId, kind} → remove material
//
// Clients come from the same factory the run engine uses (src/clients.ts):
// course host → the teacher's configured token → gated CanvasClient +
// document stores, pinned to that instance.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CanvasError,
  classifyGradableItem,
  gradingBucket,
  isAiGradableQuizQuestion,
  type CanvasAssignment,
  type CanvasSubmission,
  type GradingBucket,
  type QuizQuestion,
} from '@aigrader/canvas';
import {
  AssignmentPrepSettingsSchema,
  CourseSettingsProfileSchema,
  ResourceKindSchema,
  type AssignmentPrepSettings,
  type AssignmentResourceEntry,
  type CourseSettingsProfile,
  type ResourceKind,
} from '@aigrader/shared';
import type { CourseClientFactory } from './clients.js';
import { sortAssignments } from './grading/assignment-board.js';
import { CredentialError } from './credentials.js';

// ------------------------------------------------------------------- limits --

/** Hard cap on a material upload (decoded bytes) — the C# app's 15 MB. */
export const MAX_MATERIAL_BYTES = 15 * 1024 * 1024;
/** base64 expands 3 bytes → 4 chars; allow padding + whitespace slack. */
const MAX_MATERIAL_BASE64_CHARS = Math.ceil(MAX_MATERIAL_BYTES / 3) * 4 + 16;

// ------------------------------------------------------------- body schemas --

const baseBody = z.object({
  /** Canvas host the course lives on; null/absent = the teacher's primary instance. */
  apiDomain: z.string().nullish(),
  courseId: z.number().int().positive(),
});

const assignmentScopedBody = baseBody.extend({
  assignmentId: z.number().int().positive(),
});

const profileSaveBody = baseBody.extend({
  profile: z.unknown(),
});

const profileImportBody = baseBody.extend({
  fromCourseId: z.number().int().positive(),
});

const prepSaveBody = assignmentScopedBody.extend({
  prep: z.unknown(),
});

const uploadBody = assignmentScopedBody.extend({
  assignmentName: z.string().max(500).default(''),
  kind: ResourceKindSchema,
  filename: z.string().min(1).max(300),
  contentType: z.string().min(1).max(200),
  // Buffer.from(…, 'base64') silently skips bad characters, so shape-check
  // here — garbage must 400, not decode to a corrupt file.
  bytesBase64: z
    .string()
    .min(1)
    .max(MAX_MATERIAL_BASE64_CHARS)
    .regex(/^[A-Za-z0-9+/\r\n]+={0,2}$/, 'not valid base64'),
});

const deleteBody = assignmentScopedBody.extend({
  kind: ResourceKindSchema,
});

// ------------------------------------------------------- structural clients --

// The routes consume the client bundle structurally (like the engine's ports)
// so tests inject plain fakes; the concrete CourseClients satisfies this.

export interface CourseCanvasPort {
  getGradableItems(courseId: number): Promise<CanvasAssignment[]>;
  getAssignment(courseId: number, assignmentId: number): Promise<CanvasAssignment>;
  getSubmissions(courseId: number, assignmentId: number): Promise<CanvasSubmission[]>;
  getQuizQuestions(courseId: number, quizId: number): Promise<QuizQuestion[]>;
}

export interface CourseProfilesPort {
  get(courseId: number, apiDomain?: string | null): Promise<CourseSettingsProfile>;
  exists(courseId: number, apiDomain?: string | null): Promise<boolean>;
  save(
    courseId: number,
    profile: CourseSettingsProfile,
    apiDomain?: string | null,
  ): Promise<void>;
  import(
    targetCourseId: number,
    sourceCourseId: number,
    apiDomain?: string | null,
  ): Promise<CourseSettingsProfile | null>;
}

export interface CourseResourcesPort {
  list(courseId: number, apiDomain?: string | null): Promise<AssignmentResourceEntry[]>;
  uploadMaterial(
    courseId: number,
    assignmentId: number,
    assignmentName: string,
    kind: ResourceKind,
    originalFilename: string,
    contentType: string,
    bytes: Uint8Array,
    apiDomain?: string | null,
  ): Promise<AssignmentResourceEntry>;
  deleteMaterial(
    courseId: number,
    assignmentId: number,
    kind: ResourceKind,
    apiDomain?: string | null,
  ): Promise<void>;
  getPrep(
    courseId: number,
    assignmentId: number,
    apiDomain?: string | null,
  ): Promise<AssignmentPrepSettings>;
  savePrep(
    courseId: number,
    assignmentId: number,
    prep: AssignmentPrepSettings,
    apiDomain?: string | null,
  ): Promise<void>;
}

export interface CourseRouteClients {
  canvas: CourseCanvasPort;
  profiles: CourseProfilesPort;
  resources: CourseResourcesPort;
}

export type CourseRouteClientFactory = (args: {
  apiDomain: string | null;
}) => Promise<CourseRouteClients>;

export interface CourseRoutesDeps {
  /** The shared per-instance client factory (src/clients.ts); tests inject fakes. */
  clients: CourseRouteClientFactory;
}

// ------------------------------------------------------------------ plumbing --

/** Internal error → HTTP mapping carrier (never contains token bytes). */
class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? body.error ?? 'route error'));
  }
}

/** Uniform error → response mapping (no token material ever). */
function sendError(res: Response, err: unknown): void {
  if (err instanceof RouteError) {
    res.status(err.status).json(err.body);
    return;
  }
  if (err instanceof CredentialError) {
    res.status(409).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof CanvasError) {
    if (err.status === 401 || err.status === 403) {
      res
        .status(422)
        .json({ error: 'invalid_token', message: 'Canvas did not accept the access token.' });
      return;
    }
    if (err.status === 404) {
      res.status(404).json({ error: 'not_found', message: 'Canvas resource not found.' });
      return;
    }
    res
      .status(502)
      .json({ error: 'canvas_error', message: `Canvas request failed with status ${err.status}.` });
    return;
  }
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      message: `course-routes failure: ${err instanceof Error ? err.message : 'unknown'}`,
    }),
  );
  res.status(500).json({ error: 'internal', message: 'Unexpected engine error.' });
}

function parseBody<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RouteError(400, {
      error: 'invalid_request',
      message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.',
    });
  }
  return result.data as z.infer<S>;
}

function handle(res: Response, fn: () => Promise<void>): void {
  void fn().catch((err: unknown) => sendError(res, err));
}

// ------------------------------------------------------------ row shaping --

/** One row of the faculty assignments list (JSON-ready). */
export interface AssignmentRow {
  id: number;
  name: string;
  bucket: GradingBucket;
  itemType: 'assignment' | 'discussion' | 'quiz';
  dueAt: string | null;
  pointsPossible: number | null;
  hasRubric: boolean;
  rubricCriteriaCount: number;
  published: boolean;
  needsGradingCount: number;
  hasSubmissions: boolean;
  quizId: number | null;
  discussionTopicId: number | null;
}

function toRow(a: CanvasAssignment): AssignmentRow {
  const itemType = classifyGradableItem(a);
  return {
    id: a.id,
    name: a.name ?? `Assignment ${a.id}`,
    bucket: gradingBucket(a),
    // getGradableItems filters 'unsupported' out; the cast narrows for JSON.
    itemType: itemType === 'unsupported' ? 'assignment' : itemType,
    dueAt: a.due_at ?? null,
    pointsPossible: a.points_possible ?? null,
    hasRubric: (a.rubric?.length ?? 0) > 0,
    rubricCriteriaCount: a.rubric?.length ?? 0,
    published: a.published !== false,
    needsGradingCount: a.needs_grading_count ?? 0,
    hasSubmissions: a.has_submitted_submissions === true,
    quizId: a.quiz_id ?? null,
    discussionTopicId: a.discussion_topic?.id ?? null,
  };
}

/** Bucket order + in-bucket sort for the assignments page: work waiting first
 * (oldest due first), then upcoming (soonest first), then past (most recent
 * first) — the assignment-board ordering the C# app pinned. */
export function bucketAndSort(items: CanvasAssignment[]): AssignmentRow[] {
  const byBucket: Record<GradingBucket, CanvasAssignment[]> = {
    ready_to_grade: [],
    upcoming: [],
    past: [],
  };
  for (const a of items) byBucket[gradingBucket(a)].push(a);
  return [
    ...sortAssignments(byBucket.ready_to_grade, 'dueDate'),
    ...sortAssignments(byBucket.upcoming, 'dueDate'),
    ...sortAssignments(byBucket.past, 'dueDate', true),
  ].map(toRow);
}

/** Submission counts for the prepare screen (and the pre-run page estimate:
 * every gradable submission bills at least one page). */
function submissionCounts(subs: CanvasSubmission[]): {
  total: number;
  submitted: number;
  gradable: number;
} {
  const submitted = subs.filter(
    (s) => (s.workflow_state ?? 'unsubmitted') !== 'unsubmitted',
  ).length;
  return { total: subs.length, submitted, gradable: submitted };
}

// -------------------------------------------------------------------- routes --

export function createCourseRouter(deps: CourseRoutesDeps): Router {
  const clients: CourseRouteClientFactory =
    deps.clients;

  const router = Router();

  /** Resolve body → clients + normalized args (one shape for every route). */
  async function resolve(req: Request) {
    const body = parseBody(baseBody.passthrough(), req);
    const bundle = await clients({
      apiDomain: body.apiDomain ?? null,
    });
    return { body, apiDomain: body.apiDomain ?? null, ...bundle };
  }

  router.post('/assignments', (req, res) => {
    handle(res, async () => {
      const { body, canvas } = await resolve(req);
      const items = await canvas.getGradableItems(body.courseId);
      res.json({ assignments: bucketAndSort(items) });
    });
  });

  router.post('/assignment/detail', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(assignmentScopedBody, req);
      const { canvas } = await resolve(req);

      const assignment = await canvas.getAssignment(parsed.courseId, parsed.assignmentId);
      const itemType = classifyGradableItem(assignment);
      const submissions = await canvas.getSubmissions(parsed.courseId, parsed.assignmentId);

      // Classic quizzes: essay questions are the AI-gradable unit.
      let quiz: { quizId: number; aiGradableQuestions: number; autoGradedQuestions: number } | null =
        null;
      if (assignment.quiz_id != null) {
        const questions = await canvas.getQuizQuestions(parsed.courseId, assignment.quiz_id);
        const essay = questions.filter((q) => isAiGradableQuizQuestion(q)).length;
        quiz = {
          quizId: assignment.quiz_id,
          aiGradableQuestions: essay,
          autoGradedQuestions: questions.length - essay,
        };
      }

      res.json({
        assignment: {
          id: assignment.id,
          name: assignment.name ?? `Assignment ${assignment.id}`,
          descriptionHtml: assignment.description ?? null,
          submissionTypes: assignment.submission_types ?? [],
          pointsPossible: assignment.points_possible ?? null,
          dueAt: assignment.due_at ?? null,
          published: assignment.published !== false,
          itemType: itemType === 'unsupported' ? 'assignment' : itemType,
          quizId: assignment.quiz_id ?? null,
          discussionTopicId: assignment.discussion_topic?.id ?? null,
          hasRubric: (assignment.rubric?.length ?? 0) > 0,
          // Criterion ids ride raw (string) end-to-end — never reformatted.
          rubric: assignment.rubric ?? [],
        },
        counts: submissionCounts(submissions),
        quiz,
      });
    });
  });

  // ----------------------------------------------------------------- profile --

  router.post('/profile/get', (req, res) => {
    handle(res, async () => {
      const { body, apiDomain, profiles } = await resolve(req);
      const [profile, exists] = await Promise.all([
        profiles.get(body.courseId, apiDomain),
        profiles.exists(body.courseId, apiDomain),
      ]);
      res.json({ profile, exists });
    });
  });

  router.post('/profile/save', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(profileSaveBody, req);
      const result = CourseSettingsProfileSchema.safeParse(parsed.profile);
      if (!result.success) {
        throw new RouteError(400, {
          error: 'invalid_profile',
          message: 'The profile does not match the expected schema.',
        });
      }
      const { apiDomain, profiles } = await resolve(req);
      await profiles.save(parsed.courseId, result.data, apiDomain);
      res.json({ profile: result.data });
    });
  });

  router.post('/profile/import', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(profileImportBody, req);
      const { apiDomain, profiles } = await resolve(req);
      const imported = await profiles.import(parsed.courseId, parsed.fromCourseId, apiDomain);
      if (imported === null) {
        throw new RouteError(404, {
          error: 'no_source_profile',
          message: `Course ${parsed.fromCourseId} has no AI profile to import.`,
        });
      }
      res.json({ profile: imported });
    });
  });

  // --------------------------------------------------------------- resources --

  router.post('/resources/get', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(assignmentScopedBody, req);
      const { apiDomain, resources } = await resolve(req);
      const [prep, entries] = await Promise.all([
        resources.getPrep(parsed.courseId, parsed.assignmentId, apiDomain),
        resources.list(parsed.courseId, apiDomain),
      ]);
      res.json({
        prep,
        resources: entries.filter((e) => e.canvasAssignmentId === parsed.assignmentId),
      });
    });
  });

  router.post('/resources/prep', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(prepSaveBody, req);
      const prepResult = AssignmentPrepSettingsSchema.safeParse(parsed.prep);
      if (!prepResult.success) {
        throw new RouteError(400, {
          error: 'invalid_prep',
          message: 'Prep settings do not match the expected schema.',
        });
      }
      const { apiDomain, resources } = await resolve(req);
      await resources.savePrep(parsed.courseId, parsed.assignmentId, prepResult.data, apiDomain);
      res.json({ ok: true, prep: prepResult.data });
    });
  });

  router.post('/resources/upload', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(uploadBody, req);

      const bytes = Buffer.from(parsed.bytesBase64, 'base64');
      if (bytes.byteLength === 0) {
        throw new RouteError(400, { error: 'invalid_request', message: 'The uploaded file is empty.' });
      }
      if (bytes.byteLength > MAX_MATERIAL_BYTES) {
        throw new RouteError(413, {
          error: 'file_too_large',
          message: `Materials are capped at ${Math.floor(MAX_MATERIAL_BYTES / (1024 * 1024))} MB.`,
        });
      }

      const { apiDomain, resources } = await resolve(req);
      const entry = await resources.uploadMaterial(
        parsed.courseId,
        parsed.assignmentId,
        parsed.assignmentName,
        parsed.kind,
        parsed.filename,
        parsed.contentType,
        bytes,
        apiDomain,
      );
      res.json({ entry });
    });
  });

  router.post('/resources/delete', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(deleteBody, req);
      const { apiDomain, resources } = await resolve(req);
      await resources.deleteMaterial(parsed.courseId, parsed.assignmentId, parsed.kind, apiDomain);
      res.json({ ok: true });
    });
  });

  return router;
}
