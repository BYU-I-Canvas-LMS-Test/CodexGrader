// The Codex backend as the local server uses it: find Codex, confirm it can
// run the isolated worker, check sign-in, prepare the tool-free catalog,
// watch the usage windows — then hand the engine a ModelCallFn.
//
// Start-up never blocks the server: `ready` settles in the background, and a
// grading call made before then simply waits for it. When something is wrong
// (Codex missing, too old, signed out) calls fail with kind 'auth', which
// PAUSES the run with a plain-English fix; the next call re-probes, so fixing
// it (e.g. `codex login`) and pressing Resume is enough — no restart.

import { join } from 'node:path';
import { GradingCallError, type ModelCallFn } from '@aigrader/engine';
import { codexLoginState, probeCodex, type LoginState } from './capabilities.js';
import { prepareWorkerCatalog, type WorkerCatalog } from './catalog.js';
import { existingCodexCandidates, type CodexSource } from './locator.js';
import { createCodexModelCall } from './model-call.js';
import type { CodexCommand } from './process.js';
import { QuotaGuard, createUsageReader, type UsageReader, type UsageSnapshot } from './rate-limits.js';

export type CodexState = 'starting' | 'ready' | 'not_found' | 'unsupported' | 'logged_out' | 'error';

export interface CodexStatus {
  state: CodexState;
  /** Plain-English problem + fix, when not ready. */
  message: string | null;
  path: string | null;
  source: CodexSource | 'override' | null;
  version: string | null;
  login: LoginState;
  defaultModel: string | null;
  models: string[];
  catalogSource: WorkerCatalog['source'] | null;
}

export interface CodexBackendOptions {
  /** CODEX_PATH from ~/.aigrader/.env. */
  codexPath?: string;
  /** Folder for the worker catalog (e.g. ~/.aigrader/state/codex). */
  stateDir: string;
  /** Pause grading at this % of any usage window (default 85). */
  stopPercent?: number;
  /** Tests: run this instead of searching for Codex. */
  command?: CodexCommand;
  /** Tests: search only these paths (instead of CODEX_PATH/PATH/app folders). */
  searchPaths?: string[];
  /** Tests: usage source instead of a private app-server. */
  usageReader?: UsageReader;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  callTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface CodexBackend {
  modelCall: ModelCallFn;
  ready: Promise<CodexStatus>;
  status(): CodexStatus;
  /** Re-probe everything (after `codex login`, an update, a CODEX_PATH edit). */
  refresh(): Promise<CodexStatus>;
  /** The model to use: the requested one if this account has it, else the default. */
  resolveModel(requested?: string): { model: string; note: string | null };
  usage(force?: boolean): Promise<UsageSnapshot | null>;
}

const EMPTY: CodexStatus = {
  state: 'starting',
  message: null,
  path: null,
  source: null,
  version: null,
  login: 'unknown',
  defaultModel: null,
  models: [],
  catalogSource: null,
};

export function createCodexBackend(options: CodexBackendOptions): CodexBackend {
  const log = options.log ?? (() => {});
  let status: CodexStatus = { ...EMPTY };
  let cmd: CodexCommand | null = null;
  let catalogFile: string | null = null;
  let disable: string[] = [];
  let quota: QuotaGuard | null = null;
  let probing: Promise<CodexStatus> | null = null;
  let needsReprobe = false;

  const probe = async (): Promise<CodexStatus> => {
    const next: CodexStatus = { ...EMPTY };
    const candidates = options.command
      ? [{ cmd: options.command, source: 'override' as const, path: options.command.command }]
      : (options.searchPaths
          ? existingCodexCandidates({ codexPath: options.codexPath, env: options.env }).filter((c) => options.searchPaths!.includes(c.path))
          : existingCodexCandidates({ codexPath: options.codexPath, env: options.env })
        ).map((c) => ({
          cmd: { command: c.path, prefixArgs: [] as string[] },
          source: c.source,
          path: c.path,
        }));
    if (candidates.length === 0) {
      return {
        ...next,
        state: 'not_found',
        message:
          'Codex was not found on this computer. Install the Codex app (or set CODEX_PATH in ~/.aigrader/.env), then try again.',
      };
    }

    let lastProblem = '';
    for (const candidate of candidates) {
      try {
        const caps = await probeCodex(candidate.cmd);
        next.path = candidate.path;
        next.source = candidate.source;
        next.version = caps.version;
        if (caps.missingFlags.length > 0) {
          lastProblem = `This Codex (${caps.version}) is missing features AI Grader needs (${caps.missingFlags.join(', ')}). Update Codex, then try again.`;
          next.state = 'unsupported';
          continue;
        }
        cmd = candidate.cmd;
        disable = caps.disableFeatures;
        next.login = await codexLoginState(candidate.cmd);
        if (next.login === 'logged_out') {
          return { ...next, state: 'logged_out', message: 'Codex is not signed in. Run `codex login` (or sign in to the Codex app), then resume.' };
        }
        const catalog = await prepareWorkerCatalog(candidate.cmd, join(options.stateDir, 'worker-catalog.json'));
        catalogFile = catalog.file;
        next.defaultModel = catalog.defaultModel;
        next.models = catalog.models.filter((m) => m.listed).map((m) => m.slug);
        next.catalogSource = catalog.source;
        quota = new QuotaGuard({
          read: options.usageReader ?? createUsageReader(candidate.cmd),
          stopPercent: options.stopPercent,
        });
        return { ...next, state: 'ready', message: null };
      } catch (err) {
        lastProblem = err instanceof Error ? err.message : String(err);
      }
    }
    return { ...next, state: next.state === 'unsupported' ? 'unsupported' : 'error', message: lastProblem || 'Codex could not be started.' };
  };

  const refresh = (): Promise<CodexStatus> => {
    if (!probing) {
      probing = probe()
        .then((s) => {
          status = s;
          needsReprobe = false;
          log(
            s.state === 'ready'
              ? `[codex] Ready: Codex ${s.version} (${s.source}), default model ${s.defaultModel ?? 'unknown'}, ${disable.length} features disabled for grading.`
              : `[codex] Not ready (${s.state}): ${s.message}`,
          );
          return s;
        })
        .finally(() => {
          probing = null;
        });
    }
    return probing;
  };

  const ready = refresh();

  const inner = createCodexModelCall({
    cmd: () => cmd!,
    catalogFile: () => catalogFile,
    disableFeatures: () => disable,
    quota: () => quota ?? undefined,
    tempRoot: options.tempRoot,
    timeoutMs: options.callTimeoutMs,
    env: options.env,
  });

  const resolveModel = (requested?: string) => {
    const wanted = requested?.trim();
    if (wanted && (status.models.length === 0 || status.models.includes(wanted))) {
      return { model: wanted, note: null };
    }
    const fallback = status.defaultModel ?? wanted ?? '';
    return {
      model: fallback,
      note: wanted ? `AIGRADER_MODEL=${wanted} is not available on this Codex account; using ${fallback}.` : null,
    };
  };

  const modelCall: ModelCallFn = async (request) => {
    await ready;
    if (status.state !== 'ready' || needsReprobe) await refresh();
    if (status.state !== 'ready') {
      throw new GradingCallError(status.message ?? 'Codex is not available.', { retryable: false, kind: 'auth' });
    }
    const model = request.model || status.defaultModel || '';
    try {
      return await inner({ ...request, model });
    } catch (err) {
      if (err instanceof GradingCallError && err.kind === 'auth') needsReprobe = true;
      throw err;
    }
  };

  return {
    modelCall,
    ready,
    status: () => status,
    refresh,
    resolveModel,
    usage: async (force = false) => (quota ? quota.snapshot(force) : null),
  };
}
