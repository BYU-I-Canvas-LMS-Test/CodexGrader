// Grading-run endpoints — mounted at /runs on the in-process engine app
// (never bound to a network port). The web tier and the MCP tools reach it
// in memory; the engine owns every Canvas API call and every run mutation.
//
//   POST /runs/start                 {courseKey, apiDomain?, faculty, target,
//                                     instructions?, regradeAll?}
//                                    → fan-out → 202 {runId}
//   GET  /runs/list?courseKey=&assignmentId=
//                                    → {runs: RunListEntry[]}
//   GET  /runs/:id/snapshot          → {run} (live session first, else the
//                                     Canvas checkpoint via RunStore.loadRun)
//   POST /runs/:id/adopt             {courseKey} → {progress} (open a run this
//                                     process never started — see engine.adopt)
//   GET  /runs/:id/progress          → {progress} (counts/status/heartbeat)
//   POST /runs/:id/resume            {takeOver?} → resume/reconcile (or lift a
//                                     pause) → {outcome, …}
//   POST /runs/:id/cancel            → {status: 'cancelled'|'flagged'}
//   POST /runs/:id/edit              {userId, facultyEdited, source?,
//                                     quizSubmissionId?, questionId?}
//                                    → ~3s flush tier → {ok:true}
//                                    (DRAFT/EDITED rows only → 409 row_locked)
//   POST /runs/:id/revert            {userId, quizSubmissionId?, questionId?}
//                                    → discard the faculty edit → {ok:true}
//   POST /runs/:id/rerun             {userIds?, quizItems?} → re-grade ERROR/
//                                     DRAFT/EDITED rows (never posts) → {requeued}
//   POST /runs/:id/approve           {userIds?|all:true, approver,
//                                     reviewSeconds?} → {approved}
//                                    HUMAN-ONLY: requires the approval
//                                    capability header (see below).
//
// APPROVAL CAPABILITY (the human-in-the-loop boundary): /approve refuses any
// request that does not carry `x-aigrader-approval: <capability>`, where the
// capability is a random secret that exists only in this process's memory.
// Only the web tier's browser-guarded approve route is handed it; the MCP
// tool layer never is. With no capability configured, /approve is disabled.
// Every /runs/:id/* route re-derives its Canvas clients from the run's local
// progress record (host + course) — request bodies never carry tokens.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CanvasError } from '@aigrader/canvas';
import { timingSafeEqual } from 'node:crypto';
import { EngineError, type GradingEngine } from './coordinator/engine.js';
import { CredentialError } from './credentials.js';

/** Header carrying the in-memory approval capability. */
export const APPROVAL_CAPABILITY_HEADER = 'x-aigrader-approval';

// ------------------------------------------------------------- body schemas --

const startBody = z.object({
  courseKey: z.string().min(1),
  /** The run's instance routing comes from apiDomain / the courseKey host. */
  apiDomain: z.string().nullish(),
  faculty: z.object({
    canvasUserId: z.number().int().nonnegative(),
    name: z.string().min(1),
  }),
  target: z.object({
    kind: z.enum(['assignment', 'quiz', 'discussion']),
    assignmentId: z.number().int().positive(),
    quizId: z.number().int().positive().optional(),
    discussionId: z.number().int().positive().optional(),
  }),
  instructions: z.string().nullish(),
  regradeAll: z.boolean().optional(),
});

const editBody = z.object({
  userId: z.number().int(),
  facultyEdited: z.unknown(),
  quizSubmissionId: z.number().int().optional(),
  questionId: z.number().int().optional(),
  source: z.enum(['browser', 'codex-chat']).optional(),
});

const revertBody = z.object({
  userId: z.number().int(),
  quizSubmissionId: z.number().int().optional(),
  questionId: z.number().int().optional(),
});

const rerunBody = z
  .object({
    userIds: z.array(z.number().int()).optional(),
    quizItems: z
      .array(
        z.object({
          quizSubmissionId: z.number().int(),
          questionId: z.number().int(),
        }),
      )
      .optional(),
  })
  .refine((b) => (b.userIds?.length ?? 0) + (b.quizItems?.length ?? 0) > 0, {
    message: 'rerun requires userIds or quizItems',
  });

const resumeBody = z
  .object({
    takeOver: z.boolean().optional(),
  })
  .optional();

const approveBody = z
  .object({
    userIds: z.array(z.number().int()).optional(),
    all: z.boolean().optional(),
    approver: z.object({
      canvasUserId: z.number().int().nonnegative(),
      name: z.string().min(1),
    }),
    reviewSeconds: z.record(z.string(), z.number().nonnegative()).optional(),
  })
  .refine((b) => b.all === true || (b.userIds?.length ?? 0) > 0, {
    message: 'approve requires userIds or all:true',
  });

const adoptBody = z.object({
  courseKey: z.string().min(1),
});

const listQuery = z.object({
  courseKey: z.string().min(1),
  assignmentId: z.coerce.number().int().positive().optional(),
});

// ------------------------------------------------------------------ plumbing --

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? body.error ?? 'route error'));
  }
}

const ENGINE_ERROR_STATUS: Record<EngineError['code'], number> = {
  unknown_run: 404,
  run_document_missing: 404,
  run_not_resumable: 409,
  run_not_live: 409,
  unsupported_target: 422,
  quiz_has_no_essay_questions: 422,
  no_gradable_rows: 422,
  invalid_request: 400,
  row_locked: 409,
  run_already_active: 409,
  run_locked_elsewhere: 409,
};

/** Uniform error → response mapping (never leaks token material). */
function sendError(res: Response, err: unknown): void {
  if (err instanceof RouteError) {
    res.status(err.status).json(err.body);
    return;
  }
  if (err instanceof EngineError) {
    res.status(ENGINE_ERROR_STATUS[err.code]).json({ error: err.code, message: err.message });
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
    res
      .status(502)
      .json({ error: 'canvas_error', message: `Canvas request failed with status ${err.status}.` });
    return;
  }
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      message: `run-routes failure: ${err instanceof Error ? err.message : 'unknown'}`,
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

export interface RunRoutesDeps {
  engine: GradingEngine;
  /**
   * The in-memory approval capability (a random secret). When absent,
   * /approve is DISABLED — fail closed. Hand it ONLY to the browser-guarded
   * web approve route; never to the MCP tool layer.
   */
  approvalCapability?: string;
}

/** Constant-time check of the approval capability header. */
function hasApprovalCapability(req: Request, capability: string | undefined): boolean {
  if (!capability) return false;
  const presented = req.header(APPROVAL_CAPABILITY_HEADER);
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(capability, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRunRouter(deps: RunRoutesDeps): Router {
  const { engine } = deps;
  const router = Router();

  router.post('/start', (req, res) => {
    handle(res, async () => {
      const body = parseBody(startBody, req);
      const { runId } = await engine.startRun({
        courseKey: body.courseKey,
        apiDomain: body.apiDomain ?? undefined,
        faculty: body.faculty,
        target: body.target,
        instructions: body.instructions ?? null,
        regradeAll: body.regradeAll === true,
      });
      res.status(202).json({ runId });
    });
  });

  router.get('/list', (req, res) => {
    handle(res, async () => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new RouteError(400, {
          error: 'invalid_request',
          message: 'The courseKey query param is required.',
        });
      }
      const q = parsed.data;
      const runs = await engine.listRuns({
        courseKey: q.courseKey,
        assignmentId: q.assignmentId,
      });
      res.json({ runs });
    });
  });

  router.get('/:runId/snapshot', (req, res) => {
    handle(res, async () => {
      const run = await engine.getSnapshot(req.params.runId!);
      res.json({ run });
    });
  });

  router.post('/:runId/adopt', (req, res) => {
    handle(res, async () => {
      const body = parseBody(adoptBody, req);
      const progress = await engine.adopt(req.params.runId!, body.courseKey);
      res.json({ progress });
    });
  });

  router.get('/:runId/progress', (req, res) => {
    handle(res, async () => {
      const progress = await engine.getProgress(req.params.runId!);
      res.json({ progress });
    });
  });

  router.post('/:runId/resume', (req, res) => {
    handle(res, async () => {
      const body = parseBody(resumeBody, req);
      const result = await engine.resume(req.params.runId!, { takeOver: body?.takeOver === true });
      res.json(result);
    });
  });

  router.post('/:runId/cancel', (req, res) => {
    handle(res, async () => {
      const result = await engine.cancel(req.params.runId!);
      res.json(result);
    });
  });

  router.post('/:runId/edit', (req, res) => {
    handle(res, async () => {
      const body = parseBody(editBody, req);
      await engine.edit(req.params.runId!, {
        canvasUserId: body.userId,
        facultyEdited: body.facultyEdited,
        quizSubmissionId: body.quizSubmissionId,
        questionId: body.questionId,
        source: body.source,
      });
      res.json({ ok: true });
    });
  });

  router.post('/:runId/revert', (req, res) => {
    handle(res, async () => {
      const body = parseBody(revertBody, req);
      await engine.revert(req.params.runId!, {
        canvasUserId: body.userId,
        quizSubmissionId: body.quizSubmissionId,
        questionId: body.questionId,
      });
      res.json({ ok: true });
    });
  });

  router.post('/:runId/rerun', (req, res) => {
    handle(res, async () => {
      const body = parseBody(rerunBody, req);
      const result = await engine.rerun(req.params.runId!, {
        userIds: body.userIds,
        quizItems: body.quizItems,
      });
      res.json(result);
    });
  });

  router.post('/:runId/approve', (req, res) => {
    handle(res, async () => {
      if (!hasApprovalCapability(req, deps.approvalCapability)) {
        throw new RouteError(403, {
          error: 'approval_requires_browser',
          message:
            'Grades can only be approved by the instructor in the review page. Open the run in the browser to approve and post.',
        });
      }
      const body = parseBody(approveBody, req);
      const result = await engine.approve(req.params.runId!, {
        userIds: body.userIds,
        all: body.all,
        approver: body.approver,
        reviewSeconds: body.reviewSeconds,
      });
      res.json(result);
    });
  });

  return router;
}
