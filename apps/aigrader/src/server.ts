// `aigrader serve` — the ONE local server process per machine:
//
//   ┌ control pipe/socket (single-instance lock; CLI + MCP shim) ┐
//   │ HTTP on 127.0.0.1:<port> → the Next.js review UI           │
//   │ engine IN-PROCESS (never bound to a port)                  │
//   └ ~/.aigrader state: active runs, ledger, audit, server.json ┘
//
// Lifecycle:
//   - start: take the control endpoint (or report the running server),
//     load ~/.aigrader/.env, restore the active-runs list, build the engine,
//     bind HTTP (preferred port, then the next few, then any), install the
//     LocalHost for the web tier, start Next, then run the resume sweep so
//     runs interrupted by a crash, reboot, sleep, or idle exit pick back up.
//   - run: re-sweep every few minutes; reload .env when it changes (a fixed
//     token resumes runs paused on a Canvas 401); keep the laptop awake
//     while a run drafts or posts.
//   - stop (idle 30 min, `aigrader stop`, a signal): final checkpoint for
//     every live run (locks released), then exit. Nothing is left behind
//     but ids in ~/.aigrader/state.

import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  LocalProgressStore,
  SIGTERM_BUDGET_MS,
  StaticCredentialProvider,
  createEngine,
  createEngineApp,
  engineConfigFromEnv,
  sweep,
  type EngineRuntime,
  type GradingLlm,
} from '@aigrader/engine';
import { LOCAL_HOST_GLOBAL, setAuditSink } from '@aigrader/shared';
import { createJsonlAuditSink, pruneAudit } from './audit-sink.js';
import { openInBrowser, type BrowserOpener } from './browser.js';
import { listenControl, type ControlRequest, type ControlResponse } from './control.js';
import { EnvConfigLoader, type EnvConfig, type EnvSettings } from './env-config.js';
import { FilePostLedger } from './ledger.js';
import { unavailableLlm } from './llm.js';
import { createLocalHost, type LocalHostImpl } from './local-host.js';
import type { AigraderPaths } from './paths.js';
import { createSleepInhibitor, type SleepInhibitor } from './sleep-inhibitor.js';
import {
  activeRunsWriter,
  ensurePrivateDir,
  readActiveRuns,
  removeServerInfo,
  writeServerInfo,
} from './state.js';
import { createNextHandler, resolveWebDir, type WebHandler } from './web.js';

export const DEFAULT_UI_PORT = 47821;
export const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
export const IDLE_CHECK_MS = 60 * 1000;
export const SWEEP_EVERY_MS = 3 * 60 * 1000;
/** Ports tried after the preferred one before falling back to any free port. */
const PORT_ATTEMPTS = 10;

export interface StartServerOptions {
  paths: AigraderPaths;
  version: string;
  /** Web handler factory; default: the built Next.js review UI. */
  web?: (ctx: { host: LocalHostImpl; origin: string; port: number }) => Promise<WebHandler>;
  /** Model backend; default: the Phase 3 placeholder (never fakes a grade). */
  llm?: GradingLlm;
  openBrowser?: BrowserOpener;
  sleepInhibitor?: SleepInhibitor;
  /** Overrides AIGRADER_UI_PORT / the default. 0 = any free port. */
  port?: number;
  idleShutdownMs?: number;
  idleCheckMs?: number;
  sweepEveryMs?: number;
  envPollMs?: number;
  /** Stop on SIGINT/SIGTERM/SIGHUP (the CLI turns this on). */
  handleSignals?: boolean;
  log?: (message: string) => void;
}

export interface RunningServer {
  readonly origin: string;
  readonly port: number;
  readonly version: string;
  readonly host: LocalHostImpl;
  readonly runtime: EngineRuntime;
  readonly env: EnvConfigLoader;
  /** Opens the review UI at `path` in the system browser (with a login token). */
  openReview(path?: string): void;
  stop(reason: string): Promise<void>;
  /** Resolves with the stop reason once fully stopped. */
  readonly stopped: Promise<string>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const { paths, version } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  ensurePrivateDir(paths.home);
  ensurePrivateDir(paths.stateDir);

  let ready = false;
  let origin = '';
  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  // Filled in below; the control handler only uses them once `ready`.
  let running: RunningServer | undefined;

  // 1. Single-instance lock (throws AlreadyRunningError).
  const controlKey = randomBytes(32).toString('hex');
  const control = await listenControl({
    endpoint: paths.controlEndpoint,
    key: () => controlKey,
    handler: (request) => handleControl(request),
    onConnectionsChange: touch,
  });
  writeFileSync(paths.controlKeyFile, controlKey, { encoding: 'utf8', mode: 0o600 });

  try {
    // 2. Settings + engine.
    const env = new EnvConfigLoader(paths.envFile, {
      pollMs: opts.envPollMs,
      onChange: (config) => onEnvChange(config),
    });
    for (const problem of env.current.problems) log(`[config] ${problem}`);
    const credentials = new StaticCredentialProvider(env.current.entries);

    const progressStore = new LocalProgressStore({
      initial: readActiveRuns(paths.activeRunsFile, log),
      persist: activeRunsWriter(paths.activeRunsFile, log),
    });
    setAuditSink(createJsonlAuditSink(paths.auditDir));
    pruneAudit(paths.auditDir);
    const ledger = new FilePostLedger(paths.ledgerDir);
    ledger.prune();

    const llm = opts.llm ?? unavailableLlm();
    const runtime = createEngine({
      credentials,
      llm,
      progressStore,
      config: engineConfigFromEnv({ ...process.env, ...settingsEnv(env.current.settings) }),
      ledger,
      generator: `byui-ai-grader/${version}`,
      warn: log,
    });
    const approvalCapability = randomBytes(32).toString('base64url');
    const engineApp = createEngineApp({ runtime, credentials, llm });
    const approveApp = createEngineApp({ runtime, credentials, llm, approvalCapability });

    // 3. HTTP on loopback only.
    let web: WebHandler | null = null;
    let allowedHost = '';
    let localhostAlias = '';
    const http = createServer((req, res) => {
      const hostHeader = (req.headers.host ?? '').toLowerCase();
      if (hostHeader !== allowedHost) {
        // DNS-rebinding guard: only our exact origin is served. A bare
        // "localhost" visit is sent to the canonical 127.0.0.1 origin.
        if (hostHeader === localhostAlias && req.method === 'GET') {
          res.writeHead(302, { location: `${origin}${req.url ?? '/'}` });
          res.end();
          return;
        }
        res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('This address is not served here.');
        return;
      }
      touch();
      if (!web) {
        res.writeHead(503, { 'retry-after': '1', 'content-type': 'text/plain; charset=utf-8' });
        res.end('AI Grader is starting…');
        return;
      }
      void Promise.resolve(web.handle(req, res)).catch((err: unknown) => {
        log(`[http] Request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    const preferred = opts.port ?? env.current.settings.uiPort ?? DEFAULT_UI_PORT;
    const port = await listenLoopback(http, preferred);
    origin = `http://127.0.0.1:${port}`;
    allowedHost = `127.0.0.1:${port}`;
    localhostAlias = `localhost:${port}`;

    // 4. The web tier's door into the engine.
    const host = createLocalHost({
      version,
      origin,
      engineApp,
      approveApp,
      approvalCapability,
      onActivity: touch,
    });
    (globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL] = host;
    web = await (opts.web ?? ((ctx) => createNextHandler({ dir: resolveWebDir(), port: ctx.port })))({
      host,
      origin,
      port,
    });

    writeServerInfo(paths.serverJsonFile, {
      port,
      pid: process.pid,
      version,
      origin,
      startedAt: new Date().toISOString(),
    });
    env.watch();
    ready = true;
    log(`[server] AI Grader ${version} is running at ${origin}`);

    // 5. Background duties.
    const inhibitor = opts.sleepInhibitor ?? createSleepInhibitor({ warn: log });
    let sweeping = false;
    const runSweep = async () => {
      if (sweeping || !ready) return;
      sweeping = true;
      try {
        const report = await sweep({
          engine: runtime.engine,
          progressStore,
          registry: runtime.registry,
          warn: log,
        });
        if (report.resumed.length > 0) log(`[sweep] Resumed ${report.resumed.length} run(s).`);
      } catch (err) {
        log(`[sweep] Failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        sweeping = false;
      }
    };
    void runSweep();
    const sweepTimer = setInterval(() => void runSweep(), opts.sweepEveryMs ?? SWEEP_EVERY_MS);
    sweepTimer.unref();

    const idleMs = opts.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
    const idleTimer = setInterval(() => {
      const activity = runtime.engine.activity();
      inhibitor.set(activity.busy);
      if (activity.busy || activity.waiting || control.connections > 0) {
        touch();
        return;
      }
      if (Date.now() - lastActivity >= idleMs) void stop('idle');
    }, opts.idleCheckMs ?? IDLE_CHECK_MS);
    idleTimer.unref();

    const onSignal = () => void stop('signal');
    if (opts.handleSignals) {
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('SIGHUP', onSignal);
    }

    let resolveStopped!: (reason: string) => void;
    const stopped = new Promise<string>((resolve) => {
      resolveStopped = resolve;
    });
    let stopping: Promise<void> | null = null;
    const stop = (reason: string): Promise<void> => {
      if (stopping) return stopping;
      stopping = (async () => {
        log(`[server] Stopping (${reason}).`);
        ready = false;
        clearInterval(idleTimer);
        clearInterval(sweepTimer);
        env.close();
        inhibitor.stop();
        http.close();
        http.closeAllConnections();
        try {
          await runtime.registry.finalCheckpointAll(SIGTERM_BUDGET_MS);
        } catch (err) {
          log(`[server] Final checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          await web?.close?.();
        } catch {
          // Next shutdown is best-effort
        }
        await control.close();
        rmSync(paths.controlKeyFile, { force: true });
        removeServerInfo(paths.serverJsonFile);
        if ((globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL] === host) {
          delete (globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL];
        }
        setAuditSink(null);
        if (opts.handleSignals) {
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
          process.removeListener('SIGHUP', onSignal);
        }
        log('[server] Stopped.');
        resolveStopped(reason);
      })();
      return stopping;
    };

    const opener = opts.openBrowser ?? openInBrowser;
    const openReview = (path = '/') => {
      // Same-origin paths only (no "//host" or scheme tricks).
      const safe = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
      const token = host.issueLoginToken();
      opener(`${origin}/session/start?token=${encodeURIComponent(token)}&next=${encodeURIComponent(safe)}`);
      touch();
    };

    function onEnvChange(config: EnvConfig): void {
      credentials.replace(config.entries);
      log(`[config] Settings reloaded (${config.entries.length} Canvas instance(s)).`);
      for (const problem of config.problems) log(`[config] ${problem}`);
      if (config.entries.length > 0) {
        void runtime.engine.resumePaused('canvas_auth').then((ids) => {
          if (ids.length > 0) log(`[config] Resumed ${ids.length} run(s) paused on the Canvas token.`);
        });
      }
    }

    running = {
      origin,
      port,
      version,
      host,
      runtime,
      env,
      openReview,
      stop,
      stopped,
    };
    return running;
  } catch (err) {
    // Startup failed after taking the lock: give it back.
    await control.close();
    rmSync(paths.controlKeyFile, { force: true });
    throw err;
  }

  function handleControl(request: ControlRequest): ControlResponse {
    switch (request.op) {
      case 'hello':
        return { ok: true, version, pid: process.pid, ready, origin: ready ? origin : null };
      case 'status': {
        if (!ready || !running) return { ok: false, error: 'starting' };
        const config = running.env.current;
        return {
          ok: true,
          version,
          pid: process.pid,
          origin,
          activity: running.runtime.engine.activity(),
          config: {
            file: config.file,
            exists: config.exists,
            instances: config.instances,
            problems: config.problems,
          },
        };
      }
      case 'open': {
        if (!ready || !running) return { ok: false, error: 'starting' };
        running.openReview(typeof request.path === 'string' ? request.path : '/');
        return { ok: true, message: 'Opened the AI Grader review page in your browser.' };
      }
      case 'stop': {
        if (!running) return { ok: false, error: 'starting' };
        const server = running;
        setImmediate(() => void server.stop('requested'));
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown_op' };
    }
  }
}

/** The .env tuning knobs as the env vars engineConfigFromEnv reads. */
function settingsEnv(settings: EnvSettings): Record<string, string> {
  const out: Record<string, string> = {};
  if (settings.maxWorkers !== undefined) out.AIGRADER_MAX_WORKERS = String(settings.maxWorkers);
  if (settings.model) out.AIGRADER_MODEL = settings.model;
  if (settings.reasoningEffort) out.AIGRADER_REASONING_EFFORT = settings.reasoningEffort;
  return out;
}

/** Binds 127.0.0.1: the preferred port, the next few, then any free port. */
async function listenLoopback(server: Server, preferred: number): Promise<number> {
  const candidates =
    preferred === 0
      ? [0]
      : [...Array.from({ length: PORT_ATTEMPTS }, (_, i) => preferred + i).filter((p) => p <= 65535), 0];
  let lastErr: unknown;
  for (const port of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const address = server.address();
      if (address && typeof address === 'object') return address.port;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('No free port on 127.0.0.1.');
}

// Re-exported for tests.
export type { IncomingMessage, ServerResponse };
