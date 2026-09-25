// CodexErrorClassifier — every way a `codex exec` call can fail, mapped onto
// what the engine should do about it:
//
//   usage limit        → GradingCallError kind 'usage_limit' (+ resetsAt)
//                        → the run PAUSES and resumes itself at the reset
//   signed out         → kind 'auth' → the run pauses: "run `codex login`"
//   Codex missing      → kind 'auth' (same pause: fix Codex, then resume)
//   model unavailable  → kind 'model_unavailable' → the row errors
//   policy refusal     → kind 'refusal' → the row errors: grade manually
//   too large / 4xx    → non-retryable → the row errors
//   network / 5xx /    → a plain error with `status` (or none) → the
//   short rate limit     engine's transient retry (3 attempts, backoff)
//   tool use observed  → non-retryable (isolation must never be bypassed)
//
// Codex reports failures as event messages that often embed a JSON error
// document, e.g. {"type":"error","status":400,"error":{"type":
// "invalid_request_error","message":"The 'x' model is not supported …"}}.

import { GradingCallError, type GradingFailureKind } from '@aigrader/engine';
import type { ExecOutcome } from './events.js';
import type { RunResult } from './process.js';

export interface FailureInfo {
  kind?: GradingFailureKind;
  retryable: boolean;
  status?: number;
  message: string;
  resetsAt?: string;
}

interface ParsedError {
  status?: number;
  type?: string;
  code?: string;
  message: string;
  resetsAt?: string;
}

function parseErrorMessage(raw: string): ParsedError {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed) as Record<string, unknown>;
      const inner = (doc.error && typeof doc.error === 'object' ? doc.error : doc) as Record<string, unknown>;
      const status = typeof doc.status === 'number' ? doc.status : typeof inner.status === 'number' ? inner.status : undefined;
      return {
        status,
        type: typeof inner.type === 'string' ? inner.type : undefined,
        code: typeof inner.code === 'string' ? inner.code : undefined,
        message: typeof inner.message === 'string' ? inner.message : trimmed,
        resetsAt: resetsAtFrom(inner),
      };
    } catch {
      // not JSON after all
    }
  }
  const status = /\b(?:status|http)\s*[:=]?\s*(\d{3})\b/i.exec(trimmed)?.[1];
  return { status: status ? Number(status) : undefined, message: trimmed };
}

function resetsAtFrom(doc: Record<string, unknown>): string | undefined {
  const at = doc.resets_at ?? doc.resetsAt;
  if (typeof at === 'number' && Number.isFinite(at)) return new Date(at * 1000).toISOString();
  if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString();
  const inSeconds = doc.resets_in_seconds ?? doc.resetsInSeconds;
  if (typeof inSeconds === 'number' && Number.isFinite(inSeconds)) {
    return new Date(Date.now() + inSeconds * 1000).toISOString();
  }
  return undefined;
}

const USAGE_LIMIT = /usage[_ ]limit|hit your usage limit|usagelimitexceeded|credits?_depleted|spend[_ ]control|out of credits/i;
const AUTH = /unauthori[sz]ed|not logged in|log ?in again|codex login|re-?authenticat|token (?:has )?expired|refresh[_ ]token|invalid[_ ]?(?:api[_ ]?key|token)|authentication/i;
const MODEL = /model\b.*\b(?:not supported|does not exist|not found|unavailable|not available)|unknown model|model_not_found/i;
const REFUSAL = /cyber|policy|misalignment|safety|refus/i;
const TOO_LARGE = /context[_ ]?window|context length|too (?:long|large)|maximum context|input.*exceed/i;
const TRANSIENT = /stream disconnected|error sending request|connection|timed? ?out|temporar|overloaded|unavailable|try again|reset by peer|ECONN|ETIMEDOUT|EAI_AGAIN|network|internal server error|server error|\b5\d\d\b/i;

export function classifyFailure(input: {
  run: RunResult;
  outcome: ExecOutcome;
}): FailureInfo {
  const { run, outcome } = input;

  if (run.spawnError) {
    return {
      kind: 'auth',
      retryable: false,
      message:
        run.spawnError.code === 'ENOENT'
          ? 'Codex could not be found on this computer. Reinstall the Codex app (or set CODEX_PATH in ~/.aigrader/.env), then resume.'
          : `Codex could not be started (${run.spawnError.code ?? run.spawnError.message}).`,
    };
  }
  if (run.stoppedBy === 'timeout') {
    return { retryable: true, message: 'Codex took too long to answer (timed out).' };
  }
  if (outcome.toolItems.length > 0) {
    return {
      retryable: false,
      message: `Codex tried to use a tool (${outcome.toolItems.join(', ')}) while grading; the answer was discarded. Grade this one manually.`,
    };
  }

  const texts = [...outcome.errors, run.stderr].filter((t) => t && t.trim());
  const parsed = outcome.errors.map(parseErrorMessage);
  const all = [...parsed.map((p) => `${p.type ?? ''} ${p.code ?? ''} ${p.message}`), run.stderr].join('\n');
  const status = parsed.find((p) => p.status !== undefined)?.status;
  const resetsAt = parsed.find((p) => p.resetsAt)?.resetsAt;
  const summary = firstLine(parsed[0]?.message ?? texts[0] ?? `Codex exited with code ${run.exitCode ?? 'unknown'}.`);

  // A plain 429 is a short-term rate limit (retried below); the plan's usage
  // window is reported in words (or as rate_limit_reached) and pauses the run.
  if (USAGE_LIMIT.test(all) || /rate_limit_reached/i.test(all)) {
    return { kind: 'usage_limit', retryable: false, status, resetsAt, message: summary };
  }
  if (status === 401 || status === 403 || AUTH.test(all)) {
    return { kind: 'auth', retryable: false, status, message: summary };
  }
  if (MODEL.test(all)) {
    return { kind: 'model_unavailable', retryable: false, status, message: summary };
  }
  if (TOO_LARGE.test(all)) {
    return { retryable: false, status: status ?? 400, message: 'This submission is too large for the model to read in one pass. Grade it manually.' };
  }
  if (REFUSAL.test(all) && (status === undefined || status < 500)) {
    return { kind: 'refusal', retryable: false, status, message: summary };
  }
  if (status === 429 || (status !== undefined && status >= 500) || TRANSIENT.test(all) || status === undefined) {
    return { retryable: true, status, message: summary };
  }
  return { retryable: false, status, message: summary };
}

/**
 * The error to throw into the engine's StructuredGradingClient: typed kinds
 * and non-retryable failures as GradingCallError (never retried); transient
 * ones as a plain Error carrying `status` so the client's backoff retries.
 */
export function toThrowable(info: FailureInfo): Error {
  if (info.kind || !info.retryable) {
    return new GradingCallError(info.message, {
      retryable: false,
      kind: info.kind,
      resetsAt: info.resetsAt,
    });
  }
  const err = new Error(info.message) as Error & { status?: number };
  if (info.status !== undefined) err.status = info.status;
  return err;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? text;
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}
