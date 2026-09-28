// The contract between the local server process (apps/aigrader — the one
// `aigrader serve` process per machine) and the Next.js web tier running
// inside it. The server installs a LocalHost on globalThis BEFORE Next
// starts; the web tier's route handlers reach the in-process engine ONLY
// through it. Types only — no runtime code, no Node APIs.
//
// Human-in-the-loop boundary: `engine()` can never approve anything (the
// server dispatches it to an engine app WITHOUT the approval capability);
// `approve()` is the one path that can, and only the browser-guarded web
// approve route calls it.

/** One in-memory request to the engine's Express app. */
export interface EngineDispatchRequest {
  method: 'GET' | 'POST';
  /** Path + query, e.g. "/course/assignments" or "/runs/list?courseKey=…". */
  url: string;
  headers?: Record<string, string>;
  /** JSON-serializable body (POST only). */
  body?: unknown;
}

/** The engine's answer, fully buffered. */
export interface EngineDispatchResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The teacher's grading preferences for this computer (Grader Settings).
 * Saved by the local server in ~/.aigrader/settings.json — never in Canvas,
 * never in .env. */
export interface GradingSettings {
  /** Codex model slug; '' = the Codex account's recommended default. */
  model: string;
  /** Thinking level: 'low' | 'medium' | 'high' | 'xhigh' | 'max'. */
  reasoningEffort: string;
  /** Students graded at the same time. */
  maxWorkers: number;
}

/** A model the teacher's Codex account offers. */
export interface GradingModelOption {
  slug: string;
  displayName: string;
  /** Thinking levels this model supports (empty = unknown). */
  reasoningLevels: string[];
  defaultReasoning: string | null;
}

/** Grader Settings as the review page shows them. */
export interface GradingSettingsView {
  settings: GradingSettings;
  /** The model the next run will use (the default resolved); null = not known yet. */
  activeModel: string | null;
  /** The account's recommended default model, once Codex is ready. */
  defaultModel: string | null;
  /** Empty while Codex starts (or when it is unavailable). */
  models: GradingModelOption[];
  /** Every thinking level the grader accepts. */
  reasoningEfforts: string[];
  workers: { min: number; max: number; recommended: number };
  /** Codex readiness; null when grading doesn't run through Codex (tests). */
  codex: { state: string; message: string | null } | null;
}

export type GradingSettingsUpdateResult =
  | { ok: true; view: GradingSettingsView }
  | { ok: false; message: string };

/** What the local server exposes to the web tier. */
export interface LocalHost {
  /** Server version (shown in the UI footer; compared by the MCP shim). */
  readonly version: string;
  /** The ONE origin the review UI is served from, e.g. "http://127.0.0.1:47821".
   * Browser mutations must carry exactly this Origin. */
  readonly origin: string;
  /** Dispatch to the engine app that CANNOT approve. */
  engine(request: EngineDispatchRequest): Promise<EngineDispatchResponse>;
  /** The ONLY approval path: dispatches POST /runs/:runId/approve with the
   * in-memory approval capability attached. Call only from the browser-
   * guarded approve route after its session/CSRF/origin checks pass. */
  approve(runId: string, body: unknown): Promise<EngineDispatchResponse>;
  /** Name of the browser session cookie. */
  readonly sessionCookieName: string;
  /** True when a browser session cookie value is valid. */
  verifySession(cookieValue: string | undefined): boolean;
  /** Exchanges a single-use, short-lived login token (from a URL the server
   * opened in the system browser) for a session cookie value; null when the
   * token is unknown, used, or expired. */
  redeemLoginToken(token: string): string | null;
  /** The per-session CSRF token the review page must echo on mutations. */
  csrfTokenFor(sessionCookieValue: string): string;
  /** Records browser activity (keeps the idle-shutdown timer from firing). */
  noteActivity(): void;
  /** Grader Settings plus the choices the teacher's Codex account offers. */
  gradingSettings(): Promise<GradingSettingsView>;
  /** Validates, saves, and applies new Grader Settings (no restart). Call
   * only from the browser-guarded settings route. */
  updateGradingSettings(update: Partial<GradingSettings>): Promise<GradingSettingsUpdateResult>;
}

/** globalThis key the server installs the host under. */
export const LOCAL_HOST_GLOBAL = '__aigraderLocalHost';
