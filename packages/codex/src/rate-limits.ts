// RateLimitProbe + QuotaGuard. A teacher's Codex plan has usage windows
// (measured on a ChatGPT Edu account: a 5-hour window and a weekly window,
// each with usedPercent and a reset time). Grading a class can eat a lot of
// a window, and the teacher still needs Codex for chat — so grading stops
// at a threshold (default 85% of any window) instead of running into the
// wall. Stopping here throws the same `usage_limit` failure a real limit
// does, so the run PAUSES and resumes itself when the window resets.
//
// The numbers come from a short-lived private `codex app-server` over stdio
// (JSON-RPC: initialize → account/rateLimits/read). No model call is made.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { GradingCallError } from '@aigrader/engine';
import type { CodexCommand } from './process.js';
import { killTree } from './process.js';

export interface UsageWindow {
  /** 'primary' (e.g. 5 hours) or 'secondary' (e.g. weekly). */
  name: 'primary' | 'secondary';
  usedPercent: number;
  windowMinutes: number | null;
  /** ISO time the window resets, if known. */
  resetsAt: string | null;
}

export interface UsageSnapshot {
  /** false ⇒ the backend says ordinary usage is blocked right now. */
  allowed: boolean | null;
  windows: UsageWindow[];
  planType: string | null;
  readAt: string;
}

export type UsageReader = () => Promise<UsageSnapshot | null>;

/** Parses an account/rateLimits/read result. */
export function parseRateLimits(result: unknown, now = new Date()): UsageSnapshot | null {
  const r = result as {
    ordinaryUsageAllowed?: boolean | null;
    rateLimits?: Record<string, unknown> | null;
    rateLimitsByLimitId?: Record<string, Record<string, unknown> | undefined> | null;
  } | null;
  if (!r) return null;
  const snapshot = r.rateLimitsByLimitId?.codex ?? r.rateLimits ?? null;
  if (!snapshot) return null;
  const windows: UsageWindow[] = [];
  for (const name of ['primary', 'secondary'] as const) {
    const w = snapshot[name] as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
    if (!w || typeof w.usedPercent !== 'number') continue;
    windows.push({
      name,
      usedPercent: w.usedPercent,
      windowMinutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
      resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
    });
  }
  return {
    allowed: typeof r.ordinaryUsageAllowed === 'boolean' ? r.ordinaryUsageAllowed : null,
    windows,
    planType: typeof snapshot.planType === 'string' ? snapshot.planType : null,
    readAt: now.toISOString(),
  };
}

/** Reads the usage windows through a private, short-lived app-server. */
export function createUsageReader(cmd: CodexCommand, timeoutMs = 15_000): UsageReader {
  return () =>
    new Promise((resolve) => {
      let done = false;
      const child = spawn(cmd.command, [...cmd.prefixArgs, 'app-server'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const finish = (value: UsageSnapshot | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        killTree(child.pid);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      child.on('error', () => finish(null));
      child.on('close', () => finish(null));
      child.stdin.on('error', () => undefined);

      const send = (msg: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return;
        }
        if (msg.id === 1) {
          if (msg.error) return finish(null);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (msg.id === 2) {
          finish(msg.error ? null : parseRateLimits(msg.result));
        }
      });
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'byui-ai-grader', title: 'BYU-(A)I Grader', version: '0' }, capabilities: null },
      });
    });
}

export interface QuotaGuardOptions {
  read: UsageReader;
  /** Stop grading once any window reaches this percentage (default 85). */
  stopPercent?: number;
  /** Re-read at most this often (default 2 minutes). */
  ttlMs?: number;
  now?: () => number;
}

/** Throws a usage_limit GradingCallError when grading should stop now. */
export class QuotaGuard {
  private cached: UsageSnapshot | null = null;
  private cachedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<UsageSnapshot | null> | null = null;
  private readonly stopPercent: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: QuotaGuardOptions) {
    this.stopPercent = options.stopPercent ?? 85;
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  get last(): UsageSnapshot | null {
    return this.cached;
  }

  async snapshot(force = false): Promise<UsageSnapshot | null> {
    if (!force && this.now() - this.cachedAt < this.ttlMs) return this.cached;
    if (!this.inFlight) {
      this.inFlight = this.options
        .read()
        .catch(() => null)
        .then((snap) => {
          // A failed read keeps the last good numbers (never blocks grading).
          if (snap) this.cached = snap;
          this.cachedAt = this.now();
          return this.cached;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  /** Before each grading call. Unknown usage never blocks. */
  async check(): Promise<void> {
    const snap = await this.snapshot();
    const blocked = snap ? this.blockingWindows(snap) : [];
    if (snap?.allowed === false || blocked.length > 0) {
      throw new GradingCallError(this.message(snap!, blocked), {
        retryable: false,
        kind: 'usage_limit',
        resetsAt: this.resetsAt(snap!, blocked),
      });
    }
  }

  /** After a real usage-limit failure without a reset time: ask the backend. */
  async resetTimeNow(): Promise<string | undefined> {
    const snap = await this.snapshot(true);
    if (!snap) return undefined;
    const blocked = this.blockingWindows(snap);
    if (blocked.length > 0) return this.resetsAt(snap, blocked);
    // Codex said "limit" but no window is over our line: the fullest one is
    // the likely culprit.
    const fullest = [...snap.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
    return fullest?.resetsAt ?? undefined;
  }

  private blockingWindows(snap: UsageSnapshot): UsageWindow[] {
    return snap.windows.filter((w) => w.usedPercent >= this.stopPercent);
  }

  /** Grading can continue once EVERY blocking window has reset. */
  private resetsAt(snap: UsageSnapshot, windows: UsageWindow[]): string | undefined {
    const times = windows.map((w) => w.resetsAt).filter((t): t is string => t !== null);
    if (times.length === 0) return undefined;
    return times.sort().at(-1);
  }

  private message(snap: UsageSnapshot, blocked: UsageWindow[]): string {
    const worst = [...blocked].sort((a, b) => b.usedPercent - a.usedPercent)[0];
    const label = (w: UsageWindow) =>
      w.windowMinutes && w.windowMinutes >= 1440 * 6 ? 'weekly' : w.windowMinutes ? `${Math.round(w.windowMinutes / 60)}-hour` : '';
    if (!worst) return 'Codex says your usage limit has been reached.';
    return `Your ${label(worst)} Codex usage is at ${Math.round(worst.usedPercent)}% — grading pauses at ${this.stopPercent}% so you keep room for Codex chat.`;
  }
}
