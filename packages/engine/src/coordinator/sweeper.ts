// The resume sweep: finds non-terminal runs whose owning process died (stale
// heartbeat in the local progress index) and resumes them through the
// engine's resume/reconcile path — or finalizes CANCELLED when the faculty
// asked for a cancel the dead owner never acknowledged. The local server
// runs it once at startup (so a run interrupted by a crash, a laptop reboot,
// or an idle shutdown picks back up on its own) and then every few minutes.
//
// Safety posture:
//   - Runs live in THIS process are skipped outright (their heartbeats are
//     fresh by definition).
//   - The Canvas doc's advisory RunLock is respected (engine.resume with
//     respectLock: a fresh heartbeat from another owner ⇒ skip) — covers a
//     co-instructor's laptop holding the same run.
//   - PostedAt idempotency inside reconcile means a sweep can never
//     double-post.
//   - Per-run failures are contained; one broken run never stops the sweep.

import { RUN_LOCK_STALE_S } from '../progress/progress-writer.js';
import type { ProgressStorePort } from '../progress/progress-writer.js';
import type { GradingEngine } from './engine.js';
import type { RunRegistry } from './registry.js';

export interface SweepDeps {
  engine: GradingEngine;
  progressStore: ProgressStorePort;
  registry: RunRegistry;
  now?: () => Date;
  /** Heartbeat age (seconds) beyond which the owner counts as gone. */
  staleSeconds?: number;
  warn?: (message: string) => void;
}

export interface SweepReport {
  scanned: number;
  resumed: string[];
  finalizedCancelled: string[];
  skipped: Array<{ runId: string; reason: 'live_here' | 'fresh_heartbeat' | 'lock' }>;
  errors: Array<{ runId: string; message: string }>;
}

/** One sweep pass over every live (non-terminal) local progress record. */
export async function sweep(deps: SweepDeps): Promise<SweepReport> {
  const now = deps.now ?? (() => new Date());
  const staleMs = (deps.staleSeconds ?? RUN_LOCK_STALE_S) * 1000;
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  const report: SweepReport = {
    scanned: 0,
    resumed: [],
    finalizedCancelled: [],
    skipped: [],
    errors: [],
  };

  const live = await deps.progressStore.listLive();
  report.scanned = live.length;

  for (const doc of live) {
    const runId = doc.runId;

    // Live in this process ⇒ its heartbeats are ours and fresh.
    if (deps.registry.get(runId)) {
      report.skipped.push({ runId, reason: 'live_here' });
      continue;
    }

    // Operational staleness check (progress-record worker mirror). A missing
    // heartbeat counts as stale — the run never got a first write-through.
    const heartbeatMs = doc.worker.heartbeatAt ? Date.parse(doc.worker.heartbeatAt) : Number.NaN;
    const stale =
      !Number.isFinite(heartbeatMs) || now().getTime() - heartbeatMs >= staleMs;
    if (!stale) {
      report.skipped.push({ runId, reason: 'fresh_heartbeat' });
      continue;
    }

    try {
      // engine.resume handles the rest: the Canvas-doc RunLock (truth) is
      // re-checked with respectLock, and a pending cancelRequested finalizes
      // CANCELLED instead of re-queuing work.
      const result = await deps.engine.resume(runId, { respectLock: true });
      switch (result.outcome) {
        case 'resumed':
          report.resumed.push(runId);
          break;
        case 'finalized_cancelled':
          report.finalizedCancelled.push(runId);
          break;
        case 'skipped_lock':
          report.skipped.push({ runId, reason: 'lock' });
          break;
        case 'already_live':
          report.skipped.push({ runId, reason: 'live_here' });
          break;
        case 'terminal':
          // Terminal doc found — resume finished the bookkeeping.
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`[sweeper] Run ${runId} sweep failed: ${message}`);
      report.errors.push({ runId, message });
    }
  }

  return report;
}
