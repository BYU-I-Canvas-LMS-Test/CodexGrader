// In-process registry of live grading runs (the C# app kept sessions in
// Blazor circuit scope; the local server keeps them in one Map — its
// single-instance lock makes this correct per machine). Owns the shutdown
// behavior: on SIGTERM/SIGINT (or idle shutdown) every live session writes
// one final Canvas checkpoint + progress record inside a time budget;
// anything that misses is recovered by the resume sweep on the next start.

import type { ProgressWriter } from '../progress/progress-writer.js';
import type { PauseSignal } from './pause.js';
import type { RunSession } from './run-session.js';

/** Everything the coordinator tracks for one live run. */
export interface LiveRun {
  runId: string;
  session: RunSession;
  progress: ProgressWriter;
  /** Aborts in-flight LLM calls (cancel / shutdown). */
  controller: AbortController;
  /** In-memory cancel flag — consumers check it per item. */
  cancelRequested: boolean;
  /** Set while the run is paused (usage limit / sign-in / token) — queued
   * items are skipped and stay PENDING until the pause lifts. */
  paused?: PauseSignal;
}

/** Shutdown final-checkpoint budget. */
export const SIGTERM_BUDGET_MS = 30_000;

export class RunRegistry {
  private readonly runs = new Map<string, LiveRun>();

  create(run: LiveRun): LiveRun {
    if (this.runs.has(run.runId)) {
      throw new Error(`Run ${run.runId} is already registered.`);
    }
    this.runs.set(run.runId, run);
    return run;
  }

  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }

  /** Unregisters and disposes a run's session + progress writer (each fires
   * its own final write). */
  async remove(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    await run.session.dispose();
    await run.progress.dispose();
  }

  list(): LiveRun[] {
    return [...this.runs.values()];
  }

  get size(): number {
    return this.runs.size;
  }

  /**
   * Final checkpoint + progress write for every live session, bounded by
   * `budgetMs`. Called from the shutdown handler (and tests).
   */
  async finalCheckpointAll(budgetMs: number = SIGTERM_BUDGET_MS): Promise<void> {
    const work = Promise.allSettled(
      this.list().map(async (run) => {
        // Stop new LLM work first so flushes aren't racing fresh mutations.
        run.controller.abort();
        // Release the advisory lock: this machine is done with the run for
        // now (the resume sweep picks it up on the next start).
        await run.session.dispose({ releaseLock: true });
        await run.progress.dispose();
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      timer.unref?.();
    });
    await Promise.race([work.then(() => undefined), timeout]);
    if (timer) clearTimeout(timer);
  }
}

/**
 * Installs the SIGTERM + SIGINT handlers: one final checkpoint sweep inside
 * the budget, then exit. Returns the uninstall function (tests).
 */
export function installSigtermHandler(
  registry: RunRegistry,
  opts: { budgetMs?: number; exit?: (code: number) => void } = {},
): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handler = () => {
    console.log(
      JSON.stringify({
        severity: 'INFO',
        message: `Shutdown: final checkpoint for ${registry.size} live run(s)`,
      }),
    );
    void registry
      .finalCheckpointAll(opts.budgetMs ?? SIGTERM_BUDGET_MS)
      .catch(() => undefined)
      .then(() => exit(0));
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return () => {
    process.removeListener('SIGTERM', handler);
    process.removeListener('SIGINT', handler);
  };
}
