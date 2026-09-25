// @aigrader/engine — the grading engine as an IN-PROCESS library. The local
// server (apps/aigrader) builds one engine per machine and mounts its routes
// on an Express app that is NEVER bound to a network port: the web tier and
// the MCP tools reach it in memory. The engine owns ALL Canvas API traffic
// and every grading-run mutation.
//
// Surface (mounted by createEngineApp):
//   /canvas/*        — identity, configured instances, course list/verify
//   /course/*        — assignments, profile, resources/prep
//   /course/rubric/* — rubric editor (exact criterion-id round-trip)
//   /preview/*       — submission-viewer attachment streaming + conversions
//   /runs/*          — grading-run engine (start/snapshot/progress/resume/
//                      cancel/edit/list; approve is capability-gated)
//   /alignment/*     — outcomes-alignment audit + outcome management
//
// Coordinator shape: one in-process RunRegistry, global p-queues (grade /
// writeback), the Canvas run document as the durable checkpoint, and local
// progress records (LocalProgressStore) for polling + auto-resume.

import express, { type Express } from 'express';
import { CanvasGateRegistry, DEFAULT_MAX_CONCURRENT_REQUESTS } from '@aigrader/canvas';
import { createAlignmentRouter } from './alignment/routes.js';
import { createCanvasRouter } from './canvas-routes.js';
import { createCourseClientFactory, type CourseClientFactory } from './clients.js';
import { createCourseRouter } from './course-routes.js';
import { GradingEngine, type EngineConfig } from './coordinator/engine.js';
import { RunRegistry } from './coordinator/registry.js';
import type { CanvasCredentialProvider } from './credentials.js';
import type { GradingLlm } from './llm/structured-client.js';
import type { PostLedgerPort } from './grading/writeback.js';
import type { ProgressStorePort } from './progress/progress-writer.js';
import { createPreviewRouter } from './preview-routes.js';
import { createRubricRouter } from './rubric-routes.js';
import { createRunRouter } from './run-routes.js';
import type { SsrfOptions } from './ssrf.js';

export interface EngineRuntimeDeps {
  /** The teacher's configured Canvas instances (from ~/.aigrader/.env). */
  credentials: CanvasCredentialProvider;
  /** The grading/alignment model backend (Codex in production). */
  llm: GradingLlm;
  /** Local progress records (LocalProgressStore in production). */
  progressStore: ProgressStorePort;
  config: EngineConfig;
  /** Canvas concurrency window per token (default 6). */
  maxConcurrentCanvasRequests?: number;
  ssrfOptions?: SsrfOptions;
  /** Local post ledger (~/.aigrader/ledger) — the writeback double-post guard. */
  ledger?: PostLedgerPort;
  /** Stamped on new run documents, e.g. "byui-ai-grader/0.1.0". */
  generator?: string;
  warn?: (message: string) => void;
}

/** Everything the local server needs to hold onto for one machine. */
export interface EngineRuntime {
  engine: GradingEngine;
  /** The live engine config (the server fills in the resolved model). */
  config: EngineConfig;
  registry: RunRegistry;
  gates: CanvasGateRegistry;
  clients: CourseClientFactory;
}

/** Builds the one engine (+ registry, gates, client factory) for this process. */
export function createEngine(deps: EngineRuntimeDeps): EngineRuntime {
  // ONE gate registry for the whole process: every Canvas request made with a
  // given token — service endpoints and grading runs alike — shares that
  // token's concurrency window.
  const gates = new CanvasGateRegistry(
    deps.maxConcurrentCanvasRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
  );
  const clients = createCourseClientFactory({ credentials: deps.credentials, gates });
  const registry = new RunRegistry();
  const engine = new GradingEngine({
    registry,
    progressStore: deps.progressStore,
    llm: deps.llm,
    clients,
    config: deps.config,
    ledger: deps.ledger,
    generator: deps.generator,
    warn: deps.warn,
  });
  return { engine, config: deps.config, registry, gates, clients };
}

export interface EngineAppOptions {
  runtime: EngineRuntime;
  credentials: CanvasCredentialProvider;
  llm: GradingLlm;
  /**
   * The in-memory approval capability. Give it ONLY to the app instance the
   * browser-guarded web approve route talks to. Omit it for the app the MCP
   * tools use — that app then cannot approve anything.
   */
  approvalCapability?: string;
  ssrfOptions?: SsrfOptions;
}

/** The engine's Express app (routes only — the caller never listens on it). */
export function createEngineApp(options: EngineAppOptions): Express {
  const { runtime } = options;
  const app = express();
  // /course carries base64 material uploads (15 MB decoded ≈ 20 MB encoded);
  // registering its parser first means the global parser skips /course
  // bodies (body-parser is a no-op once req.body is populated).
  app.use('/course', express.json({ limit: '21mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.use(
    '/canvas',
    createCanvasRouter({
      credentials: options.credentials,
      gates: runtime.gates,
      ssrfOptions: options.ssrfOptions,
    }),
  );
  // Mounted before /course so rubric requests never enter the course router
  // (the rubric routes carry their own Canvas-refusal → 409 error mapping).
  app.use('/course/rubric', createRubricRouter({ clients: runtime.clients }));
  app.use('/course', createCourseRouter({ clients: runtime.clients }));
  app.use('/preview', createPreviewRouter({ clients: runtime.clients }));
  app.use(
    '/runs',
    createRunRouter({
      engine: runtime.engine,
      approvalCapability: options.approvalCapability,
    }),
  );
  app.use(
    '/alignment',
    createAlignmentRouter({
      clients: runtime.clients,
      llm: options.llm,
      model: () => ({
        model: process.env.AIGRADER_ALIGNMENT_MODEL ?? runtime.config.model,
        reasoningEffort: runtime.config.reasoningEffort,
      }),
    }),
  );
  return app;
}

// ------------------------------------------------------------- re-exports --

export { GradingEngine, EngineError, engineConfigFromEnv } from './coordinator/engine.js';
export type { EngineConfig, StartRunArgs, ResumeResult } from './coordinator/engine.js';
export type { PostLedgerPort } from './grading/writeback.js';
export { pauseSignalOf, type PauseSignal } from './coordinator/pause.js';
export { RunRegistry, installSigtermHandler, SIGTERM_BUDGET_MS } from './coordinator/registry.js';
export { sweep, type SweepReport } from './coordinator/sweeper.js';
export { INSTANCE_ID } from './coordinator/run-session.js';
export {
  LocalProgressStore,
  RUN_LOCK_STALE_S,
  deriveCounts,
  type LocalProgressStoreOptions,
  type ProgressStorePort,
} from './progress/progress-writer.js';
export {
  StaticCredentialProvider,
  CredentialError,
  toCredentials,
  tokenSha256,
  type CanvasCredential,
  type CanvasCredentialProvider,
  type CredentialEntry,
} from './credentials.js';
export {
  StructuredGradingClient,
  GradingCallError,
  LLM_CALL_TIMEOUT_MS,
  LLM_MAX_ATTEMPTS,
  type GradingFailureKind,
  type GradingLlm,
  type LlmResult,
  type LlmStats,
  type ModelCallFn,
  type ModelRequest,
  type ModelResponse,
} from './llm/structured-client.js';
export type { JsonSchema } from './llm/json-schema.js';
export { APPROVAL_CAPABILITY_HEADER } from './run-routes.js';
export type { CourseClientFactory, CourseClients } from './clients.js';
