// Rubric service endpoints — mounted at /course/rubric on the in-process
// engine app. The engine owns every Canvas API call; apps/web only relays.
// Every body carries {apiDomain?, courseId}; the token never travels.
//
//   POST /course/rubric/get    {…, assignmentId} → the assignment's rubric for
//                              editing: criteria with their EXACT Canvas ids
//                              (raw-string round-trip rule) plus the shared/
//                              sharedUnknown flags so the UI can warn that
//                              edits affect other assignments.
//   POST /course/rubric/update {…, assignmentId, rubricId, title, criteria,
//                              rubricAssociationId?, actor?} → updateRubric
//                              (Canvas REPLACES the criteria array — callers
//                              pass every row; empty ids mark NEW rows and are
//                              omitted from the form so Canvas mints fresh
//                              ones). Canvas 4xx refusals → 409 with Canvas's
//                              own message. Audits RubricUpdated (IDs/counts
//                              only + actorCanvasUserId), then re-fetches so
//                              the UI shows what Canvas actually stored.
//
// This is its own router (not a /course route) because rubric mutations need
// the alignment routes' refusal mapping — Canvas 4xx → 409 with the Canvas
// message — which the /course mapper deliberately lacks.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Pages\
// OutcomesAlignment.razor (@code — LoadRubricAsync / SaveRubricAsync flows,
// RubricUpdated audit fields) over CanvasApiClient.cs
// GetAssignmentRubricAsync / UpdateRubricAsync (already ported to
// @aigrader/canvas and pinned by its tests).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CanvasError,
  type AssignmentRubric,
  type RubricCriterionInput,
} from '@aigrader/canvas';
import { audit as sharedAudit } from '@aigrader/shared';
import { CredentialError } from './credentials.js';

// ------------------------------------------------------------- body schemas --

const actorSchema = z
  .object({
    /** Canvas numeric user id (string end-to-end — raw-string discipline). */
    canvasUserId: z.string().min(1).max(64),
  })
  .nullish();

const baseBody = z.object({
  /** Canvas host the course lives on; null/absent = the teacher's primary instance. */
  apiDomain: z.string().nullish(),
  courseId: z.number().int().positive(),
});

const getBody = baseBody.extend({
  assignmentId: z.number().int().positive(),
});

// Criterion/rating rows ride through EXACTLY as the editor sends them —
// ids stay raw strings (or numbers) and are never reformatted; '' (or an
// absent id) marks a NEW row whose id key buildRubricUpdateForm omits.
const ratingInputSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  long_description: z.string().nullish(),
  points: z.number(),
});

const criterionInputSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  description: z.string().nullish(),
  long_description: z.string().nullish(),
  points: z.number(),
  learning_outcome_id: z.union([z.string(), z.number()]).nullish(),
  ratings: z.array(ratingInputSchema).nullish(),
});

const updateBody = baseBody.extend({
  assignmentId: z.number().int().positive(),
  rubricId: z.number().int().positive(),
  title: z.string().min(1).max(500),
  /** Canvas REPLACES the criteria array — a save always carries every row. */
  criteria: z.array(criterionInputSchema).min(1),
  rubricAssociationId: z.union([z.number(), z.string()]).nullish(),
  /** The acting faculty member, for the audit trail (IDs only). */
  actor: actorSchema,
});

// ------------------------------------------------------- structural clients --

/** The Canvas surface these routes need (CanvasClient satisfies this). */
export interface RubricCanvasPort {
  getAssignmentRubric(courseId: number, assignmentId: number): Promise<AssignmentRubric>;
  updateRubric(
    courseId: number,
    rubricId: number,
    args: {
      title: string;
      criteria: readonly RubricCriterionInput[];
      rubricAssociationId?: number | string | null;
    },
  ): Promise<void>;
}

export interface RubricRouteClients {
  canvas: RubricCanvasPort;
}

export type RubricRouteClientFactory = (args: {
  apiDomain: string | null;
}) => Promise<RubricRouteClients>;

export interface RubricRoutesDeps {
  /** The shared per-instance client factory (src/clients.ts); tests inject fakes. */
  clients: RubricRouteClientFactory;
  /** Audit sink injection (tests). */
  auditFn?: typeof sharedAudit;
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

/** Uniform error → response mapping (no token material ever). Same shape as
 * alignment-routes: Canvas 4xx refusals on rubric writes surface as 409 with
 * Canvas's own message (e.g. an outcome-linked criterion Canvas won't accept)
 * so the UI can show why — the C# page surfaced the exception message. */
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
    if (err.status >= 400 && err.status < 500) {
      res.status(409).json({
        error: 'canvas_rejected',
        message: err.canvasMessage ?? `Canvas refused the request (status ${err.status}).`,
      });
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
      message: `rubric-routes failure: ${err instanceof Error ? err.message : 'unknown'}`,
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

// -------------------------------------------------------------------- routes --

export function createRubricRouter(deps: RubricRoutesDeps): Router {
  const clients: RubricRouteClientFactory =
    deps.clients;
  const audit = deps.auditFn ?? sharedAudit;

  const router = Router();

  router.post('/get', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(getBody, req);
      const { canvas } = await clients({
        apiDomain: parsed.apiDomain ?? null,
      });
      // The full AssignmentRubric passes through: criteria ids raw, plus
      // shared/otherAssignmentCount/sharedUnknown for the UI's warning banner.
      const rubric = await canvas.getAssignmentRubric(parsed.courseId, parsed.assignmentId);
      res.json({ rubric });
    });
  });

  router.post('/update', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(updateBody, req);
      const { canvas } = await clients({
        apiDomain: parsed.apiDomain ?? null,
      });

      await canvas.updateRubric(parsed.courseId, parsed.rubricId, {
        title: parsed.title,
        criteria: parsed.criteria,
        rubricAssociationId: parsed.rubricAssociationId ?? null,
      });

      // IDs and counts only — never criterion text (audit PII guardrail).
      audit('RubricUpdated', {
        canvasCourseId: parsed.courseId,
        canvasAssignmentId: parsed.assignmentId,
        rubricId: parsed.rubricId,
        rubricCriterionCount: parsed.criteria.length,
        apiDomain: parsed.apiDomain ?? 'default',
        actorCanvasUserId: parsed.actor?.canvasUserId,
      });

      // Re-fetch to confirm what Canvas actually stored (the C# page's
      // post-save LoadRubricAsync) so the UI renders Canvas's truth.
      const rubric = await canvas.getAssignmentRubric(parsed.courseId, parsed.assignmentId);
      res.json({ ok: true, rubric });
    });
  });

  return router;
}
