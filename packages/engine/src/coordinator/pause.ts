// Run-level PAUSE classification. Some failures aren't the student's row's
// fault and would hit every remaining row the same way — the teacher's Codex
// usage limit, Codex refusing requests for a few minutes (HTTP 429), an
// expired Codex sign-in, or a Canvas token that stopped working. Instead of
// marking every row ERROR, the engine PAUSES the run: the row goes back to
// PENDING, queued items stop, and the run document says why and how to fix
// it. Resuming (automatically when a usage window resets or a rate-limit
// pause ends, or when the teacher fixes the sign-in/token) continues from
// there — nothing is lost and nothing is double-graded.

import { CanvasError } from '@aigrader/canvas';
import type { PauseReason } from '@aigrader/shared';
import { GradingCallError, RATE_LIMIT_PAUSE_MS } from '../llm/structured-client.js';

export interface PauseSignal {
  reason: PauseReason;
  /** When the pause lifts on its own (usage windows), if known. */
  until?: string;
  /** Faculty-readable explanation + fix. */
  message: string;
}

/** The pause a failure calls for, or null when it's an ordinary row error. */
export function pauseSignalOf(err: unknown): PauseSignal | null {
  if (err instanceof GradingCallError) {
    if (err.kind === 'usage_limit') {
      return {
        reason: 'usage_limit',
        until: err.resetsAt,
        message: err.resetsAt
          ? 'Your Codex usage limit was reached. Grading pauses and continues automatically when it resets.'
          : 'Your Codex usage limit was reached. Grading is paused; resume it once your limit resets.',
      };
    }
    if (err.kind === 'rate_limited') {
      // Stored as a usage-limit pause (pause reasons are a persisted enum —
      // never extended): it lifts by itself at `until`, the same way.
      return {
        reason: 'usage_limit',
        until: err.resetsAt ?? new Date(Date.now() + RATE_LIMIT_PAUSE_MS).toISOString(),
        message:
          'Codex is getting too many requests right now (HTTP 429 Too Many Requests). Grading paused for a few minutes and continues automatically; nothing is lost.',
      };
    }
    if (err.kind === 'auth') {
      return {
        reason: 'codex_auth',
        message: 'Codex needs you to sign in again. Run `codex login`, then resume the run.',
      };
    }
    return null;
  }
  if (err instanceof CanvasError && err.status === 401) {
    return {
      reason: 'canvas_auth',
      message:
        'Canvas rejected your access token. Update CANVAS_API_TOKEN in ~/.aigrader/.env (run `aigrader config`), then resume the run.',
    };
  }
  return null;
}
