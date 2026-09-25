// Alignment service endpoints — mounted at /alignment on the in-process
// engine app. The engine owns every Canvas API call; apps/web only relays.
// Every body carries {apiDomain?, courseId}; mutation bodies may add
// {actor: {canvasUserId}} so audits record who acted (IDs only).
//
//   POST /alignment/report/get     → alignment.json latest + history stubs;
//                                    when no audit is saved, a live (non-
//                                    persisted) heuristic fills `latest`.
//   POST /alignment/run            {…, method: 'heuristic'|'ai'} → run the
//                                    review. Heuristic is a live snapshot;
//                                    AI appends to alignment.json history
//                                    and emits the AlignmentReviewed audit.
//   POST /alignment/outcomes/course-list        → course outcomes (+ profile
//                                    outcome-ref sync, as the C# page did on load)
//   POST /alignment/outcomes/library-root       → account library entry point
//   POST /alignment/outcomes/library-subgroups  {…, groupId, accountId?}
//   POST /alignment/outcomes/library-outcomes   {…, groupId, accountId?}
//   POST /alignment/outcomes/link    {…, outcomeId} → link + audit + fresh list
//   POST /alignment/outcomes/unlink  {…, outcomeId} → unlink + audit + fresh list
//   POST /alignment/outcomes/create  {…, title, description?} → create + audit
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Pages\
// OutcomesAlignment.razor (@code — load/run/link/unlink/create flows, the
// library browser's account resolution, and SyncOutcomesIntoProfileAsync).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CanvasError,
  type CanvasAssignment,
  type CanvasCourseInfo,
  type CanvasOutcome,
  type CanvasOutcomeGroup,
} from '@aigrader/canvas';
import {
  audit as sharedAudit,
  type AlignmentHistoryDocument,
  type AlignmentReport,
  type AlignmentRunSummary,
  type CourseSettingsProfile,
} from '@aigrader/shared';
import { stripHtml } from '../grading/prompts/strip-html.js';
import type { GradingLlm } from '../llm/structured-client.js';
import { CredentialError } from '../credentials.js';
import {
  ALIGNMENT_SYSTEM_PROMPT,
  buildAlignmentUserMessage,
} from './review-agent.js';
import {
  AlignmentService,
  alignmentModelFromEnv,
  type AlignmentReviewFn,
} from './service.js';

// ------------------------------------------------------------- body schemas --

const baseBody = z.object({
  /** Canvas host the course lives on; null/absent = the teacher's primary instance. */
  apiDomain: z.string().nullish(),
  courseId: z.number().int().positive(),
  /** The acting faculty member, for mutation audit trails (IDs only —
   * canvasUserId is a Canvas numeric id as a string, never a name). */
  actor: z
    .object({ canvasUserId: z.string().min(1).max(64) })
    .nullish(),
});

const runBody = baseBody.extend({
  method: z.enum(['heuristic', 'ai']),
});

const groupScopedBody = baseBody.extend({
  groupId: z.number().int().positive(),
  /** The library account, as returned by library-root (re-resolved if absent). */
  accountId: z.number().int().positive().optional(),
});

const outcomeScopedBody = baseBody.extend({
  outcomeId: z.number().int().positive(),
});

const createBody = baseBody.extend({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).default(''),
});

// ------------------------------------------------------- structural clients --

/** The Canvas surface these routes need (CanvasClient satisfies this). */
export interface AlignmentCanvasRoutePort {
  getGradableItems(courseId: number): Promise<CanvasAssignment[]>;
  getCourseOutcomes(courseId: number): Promise<CanvasOutcome[]>;
  getCourseInfo(courseId: number): Promise<CanvasCourseInfo>;
  getAccountRootOutcomeGroup(accountId: number): Promise<CanvasOutcomeGroup>;
  getAccountOutcomeSubgroups(accountId: number, groupId: number): Promise<CanvasOutcomeGroup[]>;
  getAccountOutcomeGroupOutcomes(accountId: number, groupId: number): Promise<CanvasOutcome[]>;
  linkOutcomeToCourse(courseId: number, outcomeId: number): Promise<void>;
  unlinkOutcomeFromCourse(courseId: number, outcomeId: number): Promise<void>;
  createCourseOutcome(
    courseId: number,
    title: string,
    description: string,
  ): Promise<CanvasOutcome | null>;
}

/** Profile surface for the outcome-ref sync (ProfileStore satisfies this). */
export interface AlignmentProfilesPort {
  get(courseId: number, apiDomain?: string | null): Promise<CourseSettingsProfile>;
  save(
    courseId: number,
    profile: CourseSettingsProfile,
    apiDomain?: string | null,
  ): Promise<void>;
  /** Exclusive read-modify-write (ProfileStore.update); preferred when present. */
  update?(
    courseId: number,
    mutate: (current: CourseSettingsProfile) => CourseSettingsProfile | null,
    apiDomain?: string | null,
  ): Promise<void>;
}

/** alignment.json surface (AlignmentStore satisfies this). */
export interface AlignmentDocsPort {
  get(courseId: number, apiDomain?: string | null): Promise<AlignmentHistoryDocument | null>;
  appendReport(
    courseId: number,
    report: AlignmentReport,
    apiDomain?: string | null,
  ): Promise<AlignmentHistoryDocument>;
}

export interface AlignmentRouteClients {
  canvas: AlignmentCanvasRoutePort;
  profiles: AlignmentProfilesPort;
  alignment: AlignmentDocsPort;
}

export type AlignmentRouteClientFactory = (args: {
  apiDomain: string | null;
}) => Promise<AlignmentRouteClients>;

export interface AlignmentRoutesDeps {
  /** The process's grading LLM client (unused when `review` is injected). */
  llm?: Pick<GradingLlm, 'reviewAlignment'>;
  /** The shared per-instance client factory (src/clients.ts); tests inject fakes. */
  clients: AlignmentRouteClientFactory;
  /** Per-assignment review injection (tests) — replaces the LLM call. */
  review?: AlignmentReviewFn;
  /** Audit sink injection (tests). */
  auditFn?: typeof sharedAudit;
  /** Model + effort for reviews, read per call (default: from env). */
  model?: () => { model: string; reasoningEffort: string };
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
 * course-routes, plus: Canvas 4xx refusals on outcome mutations surface with
 * Canvas's own message (e.g. "Outcome cannot be deleted because it is aligned
 * to content") so the UI can show why — the C# page's behavior. */
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
      message: `alignment-routes failure: ${err instanceof Error ? err.message : 'unknown'}`,
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

/** JSON-ready outcome row (descriptions arrive as HTML from Canvas). */
export type OutcomeRow = { id: number; title: string; description: string };

function toOutcomeRow(o: CanvasOutcome): OutcomeRow {
  return {
    id: o.id,
    title: o.title ?? `Outcome ${o.id}`,
    description: stripHtml(o.description ?? ''),
  };
}

function toGroupRow(g: CanvasOutcomeGroup): { id: number; title: string } {
  return { id: g.id, title: g.title ?? '' };
}

/** History rows for the UI: full prior reports demoted to trend stubs, plus
 * the archive stubs, newest first (port of OutcomesAlignment.razor LoadHistory). */
export function historySummaries(doc: AlignmentHistoryDocument): AlignmentRunSummary[] {
  const fromHistory: AlignmentRunSummary[] = doc.history.map((r) => ({
    scannedAt: r.scannedAt,
    method: r.method,
    alignmentScore: r.alignmentScore,
    issueCount: r.issues.length,
    highSeverityCount: r.issues.filter((i) => i.severity === 'high').length,
  }));
  return [...fromHistory, ...doc.archive].sort((a, b) =>
    b.scannedAt.localeCompare(a.scannedAt),
  );
}

// -------------------------------------------------------------------- routes --

export function createAlignmentRouter(deps: AlignmentRoutesDeps): Router {
  const clients: AlignmentRouteClientFactory = deps.clients;
  const audit = deps.auditFn ?? sharedAudit;

  const review: AlignmentReviewFn =
    deps.review ??
    (async (input) => {
      const llm = deps.llm;
      if (!llm) {
        throw new Error('Alignment routes need an LLM client (or an injected review fn).');
      }
      const { model, reasoningEffort } = (deps.model ?? alignmentModelFromEnv)();
      const { output } = await llm.reviewAlignment({
        systemPrompt: ALIGNMENT_SYSTEM_PROMPT,
        userMessage: buildAlignmentUserMessage(input),
        model,
        reasoningEffort,
      });
      return output;
    });

  const router = Router();

  /** Resolve body → clients + normalized args (one shape for every route). */
  async function resolve(req: Request) {
    const body = parseBody(baseBody.passthrough(), req);
    const bundle = await clients({
      apiDomain: body.apiDomain ?? null,
    });
    const service = new AlignmentService({
      canvas: bundle.canvas,
      store: {
        appendReport: (courseId, report) => bundle.alignment.appendReport(courseId, report),
      },
      review,
    });
    return { body, apiDomain: body.apiDomain ?? null, service, ...bundle };
  }

  /** Caches the live outcome refs into the AI Profile (AIGrader.json) so the
   * grading prompt sees real Canvas outcomes — the C# page ran this sync on
   * load and after every outcome change (SyncOutcomesIntoProfileAsync). */
  async function syncOutcomesIntoProfile(
    profiles: AlignmentProfilesPort,
    courseId: number,
    outcomes: CanvasOutcome[],
  ): Promise<void> {
    const next = outcomes.map((o) => ({
      id: String(o.id),
      title: o.title ?? '',
      description: stripHtml(o.description ?? ''),
    }));
    // Write only on a real change: listing outcomes is a read, and every
    // needless AIGrader.json save is a Canvas upload (and a race window
    // against a co-instructor's profile edit).
    const apply = (profile: CourseSettingsProfile): CourseSettingsProfile | null => {
      const current = (profile.canvasOutcomes ?? []).map((o) => ({
        id: String(o.id),
        title: o.title ?? '',
        description: o.description ?? '',
      }));
      if (JSON.stringify(current) === JSON.stringify(next)) return null;
      return { ...profile, canvasOutcomes: next };
    };
    if (profiles.update) {
      await profiles.update(courseId, apply);
      return;
    }
    const updated = apply(await profiles.get(courseId));
    if (updated) await profiles.save(courseId, updated);
  }

  /** Course outcomes + profile sync, shared by every mutation's refresh. */
  async function refreshedOutcomes(
    canvas: AlignmentCanvasRoutePort,
    profiles: AlignmentProfilesPort,
    courseId: number,
  ): Promise<OutcomeRow[]> {
    const outcomes = await canvas.getCourseOutcomes(courseId);
    await syncOutcomesIntoProfile(profiles, courseId, outcomes);
    return outcomes.map(toOutcomeRow);
  }

  /** The account whose outcome library the course draws from — the ROOT
   * account (e.g. the institution), not the course's sub-account. */
  async function resolveLibraryAccount(
    canvas: AlignmentCanvasRoutePort,
    courseId: number,
    provided?: number,
  ): Promise<number> {
    if (provided != null) return provided;
    const info = await canvas.getCourseInfo(courseId);
    const accountId = info.root_account_id ?? info.account_id;
    if (accountId == null) {
      throw new RouteError(404, {
        error: 'no_account',
        message: "Could not resolve the course's Canvas account.",
      });
    }
    return accountId;
  }

  // ------------------------------------------------------------------ report --

  router.post('/report/get', (req, res) => {
    handle(res, async () => {
      const { body, apiDomain, alignment, service } = await resolve(req);
      const doc = await alignment.get(body.courseId, apiDomain);
      // No saved audit: the heuristic gives an instant baseline without LLM
      // cost (and is NOT persisted) — the C# page-load behavior.
      const latest = doc?.latest ?? (await service.runHeuristic(body.courseId));
      res.json({ latest, history: doc ? historySummaries(doc) : [] });
    });
  });

  router.post('/run', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(runBody, req);
      const { apiDomain, alignment, service } = await resolve(req);

      if (parsed.method === 'heuristic') {
        const report = await service.runHeuristic(parsed.courseId);
        res.json({ latest: report, history: null });
        return;
      }

      const report = await service.runAiReview(parsed.courseId);
      audit('AlignmentReviewed', {
        canvasCourseId: parsed.courseId,
        apiDomain: apiDomain ?? 'default',
        method: report.method,
        alignmentScore: report.alignmentScore,
        issueCount: report.issues.length,
        actorCanvasUserId: parsed.actor?.canvasUserId,
      });
      const doc = await alignment.get(parsed.courseId, apiDomain);
      res.json({ latest: report, history: doc ? historySummaries(doc) : [] });
    });
  });

  // ---------------------------------------------------------------- outcomes --

  router.post('/outcomes/course-list', (req, res) => {
    handle(res, async () => {
      const { body, canvas, profiles } = await resolve(req);
      res.json({ outcomes: await refreshedOutcomes(canvas, profiles, body.courseId) });
    });
  });

  router.post('/outcomes/library-root', (req, res) => {
    handle(res, async () => {
      const { body, canvas } = await resolve(req);
      const accountId = await resolveLibraryAccount(canvas, body.courseId);
      const root = await canvas.getAccountRootOutcomeGroup(accountId);
      res.json({ accountId, group: toGroupRow(root) });
    });
  });

  router.post('/outcomes/library-subgroups', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(groupScopedBody, req);
      const { canvas } = await resolve(req);
      const accountId = await resolveLibraryAccount(canvas, parsed.courseId, parsed.accountId);
      const subgroups = await canvas.getAccountOutcomeSubgroups(accountId, parsed.groupId);
      res.json({ accountId, subgroups: subgroups.map(toGroupRow) });
    });
  });

  router.post('/outcomes/library-outcomes', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(groupScopedBody, req);
      const { canvas } = await resolve(req);
      const accountId = await resolveLibraryAccount(canvas, parsed.courseId, parsed.accountId);
      const outcomes = await canvas.getAccountOutcomeGroupOutcomes(accountId, parsed.groupId);
      res.json({ accountId, outcomes: outcomes.map(toOutcomeRow) });
    });
  });

  router.post('/outcomes/link', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(outcomeScopedBody, req);
      const { apiDomain, canvas, profiles } = await resolve(req);
      await canvas.linkOutcomeToCourse(parsed.courseId, parsed.outcomeId);
      audit('OutcomeLinked', {
        canvasCourseId: parsed.courseId,
        outcomeId: parsed.outcomeId,
        apiDomain: apiDomain ?? 'default',
        actorCanvasUserId: parsed.actor?.canvasUserId,
      });
      res.json({ outcomes: await refreshedOutcomes(canvas, profiles, parsed.courseId) });
    });
  });

  router.post('/outcomes/unlink', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(outcomeScopedBody, req);
      const { apiDomain, canvas, profiles } = await resolve(req);
      try {
        await canvas.unlinkOutcomeFromCourse(parsed.courseId, parsed.outcomeId);
      } catch (err) {
        // "Not linked" is a plain Error from the client; Canvas refusals
        // (outcome already used in an assessment) are CanvasError 4xx and
        // map to 409 with Canvas's message in sendError.
        if (err instanceof Error && !(err instanceof CanvasError)) {
          throw new RouteError(409, { error: 'outcome_conflict', message: err.message });
        }
        throw err;
      }
      audit('OutcomeUnlinked', {
        canvasCourseId: parsed.courseId,
        outcomeId: parsed.outcomeId,
        apiDomain: apiDomain ?? 'default',
        actorCanvasUserId: parsed.actor?.canvasUserId,
      });
      res.json({ outcomes: await refreshedOutcomes(canvas, profiles, parsed.courseId) });
    });
  });

  router.post('/outcomes/create', (req, res) => {
    handle(res, async () => {
      const parsed = parseBody(createBody, req);
      const { apiDomain, canvas, profiles } = await resolve(req);
      const created = await canvas.createCourseOutcome(
        parsed.courseId,
        parsed.title.trim(),
        parsed.description.trim(),
      );
      if (created === null) {
        // Rejections throw with Canvas's own message (mapped in sendError);
        // reaching here means Canvas accepted but returned no body.
        throw new RouteError(502, {
          error: 'no_created_outcome',
          message:
            'Canvas did not return the created outcome — refresh to confirm it was created.',
        });
      }
      audit('OutcomeCreated', {
        canvasCourseId: parsed.courseId,
        outcomeId: created.id,
        apiDomain: apiDomain ?? 'default',
        actorCanvasUserId: parsed.actor?.canvasUserId,
      });
      res.json({
        outcome: toOutcomeRow(created),
        outcomes: await refreshedOutcomes(canvas, profiles, parsed.courseId),
      });
    });
  });

  return router;
}
