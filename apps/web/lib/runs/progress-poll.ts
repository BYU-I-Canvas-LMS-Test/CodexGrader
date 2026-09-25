// Pure decision logic for the run-review screen's polling loop (M4). The
// client hook polls /api/runs/[runId]/progress every ~3s while the run is
// active and refetches the (much heavier) /snapshot document:
//
//   - immediately on a status transition (RUNNING → REVIEWING, → POSTING, …)
//   - on count/heartbeat movement, debounced to at most one snapshot per
//     `minIntervalMs` (default 5s)
//
// Kept pure (no timers, no fetch) so the transition rules are unit-testable.

export const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

/** Statuses during which the worker is actively mutating the run. */
export const ACTIVE_RUN_STATUSES = ['PENDING', 'RUNNING', 'POSTING'] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function isActiveRunStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

/** Keep the ~3s progress poll running only while the worker is moving. */
export function shouldContinuePolling(status: string): boolean {
  return isActiveRunStatus(status);
}

/** The slice of a runProgress payload the poll decisions read. */
export interface ProgressSample {
  status: string;
  counts?: Record<string, unknown> | null;
  updatedAt?: string | null;
}

export type SnapshotRefetchReason =
  | 'initial'
  | 'status-change'
  | 'progress-change'
  | 'debounced'
  | 'none';

export interface SnapshotDecision {
  refetch: boolean;
  reason: SnapshotRefetchReason;
}

/**
 * Given the previous and next progress samples, decide whether the snapshot
 * should be refetched now. Status transitions bypass the debounce; count
 * movement respects it (≥ minIntervalMs since the last snapshot fetch).
 */
export function decideSnapshotRefetch(
  prev: ProgressSample | null,
  next: ProgressSample,
  lastSnapshotAtMs: number | null,
  nowMs: number,
  minIntervalMs = 5_000,
): SnapshotDecision {
  if (prev === null) return { refetch: true, reason: 'initial' };
  if (prev.status !== next.status) return { refetch: true, reason: 'status-change' };

  const countsChanged =
    JSON.stringify(prev.counts ?? null) !== JSON.stringify(next.counts ?? null) ||
    (prev.updatedAt ?? null) !== (next.updatedAt ?? null);
  if (!countsChanged) return { refetch: false, reason: 'none' };

  if (lastSnapshotAtMs === null || nowMs - lastSnapshotAtMs >= minIntervalMs) {
    return { refetch: true, reason: 'progress-change' };
  }
  return { refetch: false, reason: 'debounced' };
}

/** Heartbeat staleness horizon — mirrors the worker's RUN_LOCK_STALE_S. */
export const HEARTBEAT_STALE_MS = 150_000;

/**
 * True when a non-terminal run's worker heartbeat is missing or old — the
 * review screen offers the Resume button in that state (the sweeper would
 * also pick it up within its 5-minute cadence).
 */
export function isHeartbeatStale(
  status: string,
  heartbeatAt: string | null | undefined,
  nowMs: number,
  staleMs = HEARTBEAT_STALE_MS,
): boolean {
  if (isTerminalRunStatus(status)) return false;
  if (!heartbeatAt) return true;
  const beat = Date.parse(heartbeatAt);
  if (!Number.isFinite(beat)) return true;
  return nowMs - beat >= staleMs;
}
