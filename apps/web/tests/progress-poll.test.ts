// The run-review polling brain (lib/runs/progress-poll): when to keep the
// ~3s progress poll alive, when a snapshot refetch fires immediately (status
// transitions) vs. debounced (count movement), and when the heartbeat is
// stale enough to offer Resume.

import { describe, expect, it } from 'vitest';
import {
  decideSnapshotRefetch,
  isActiveRunStatus,
  isHeartbeatStale,
  isTerminalRunStatus,
  shouldContinuePolling,
} from '../lib/runs/progress-poll';

describe('status classification', () => {
  it('treats COMPLETED/FAILED/CANCELLED as terminal', () => {
    for (const s of ['COMPLETED', 'FAILED', 'CANCELLED']) {
      expect(isTerminalRunStatus(s)).toBe(true);
      expect(shouldContinuePolling(s)).toBe(false);
    }
  });

  it('polls while the worker is moving (PENDING/RUNNING/POSTING)', () => {
    for (const s of ['PENDING', 'RUNNING', 'POSTING']) {
      expect(isActiveRunStatus(s)).toBe(true);
      expect(shouldContinuePolling(s)).toBe(true);
    }
  });

  it('does not poll during REVIEWING (mutations trigger explicit refreshes)', () => {
    expect(shouldContinuePolling('REVIEWING')).toBe(false);
    expect(isTerminalRunStatus('REVIEWING')).toBe(false);
  });
});

describe('decideSnapshotRefetch', () => {
  const counts = (drafted: number) => ({ total: 10, drafted });

  it('always fetches the first snapshot', () => {
    expect(
      decideSnapshotRefetch(null, { status: 'RUNNING', counts: counts(0) }, null, 0),
    ).toEqual({ refetch: true, reason: 'initial' });
  });

  it('refetches immediately on a status transition, ignoring the debounce', () => {
    const decision = decideSnapshotRefetch(
      { status: 'RUNNING', counts: counts(9) },
      { status: 'REVIEWING', counts: counts(10) },
      /* lastSnapshotAtMs */ 999,
      /* nowMs */ 1_000, // 1ms after the last snapshot — still fires
    );
    expect(decision).toEqual({ refetch: true, reason: 'status-change' });
  });

  it('refetches on count movement once the debounce window has passed', () => {
    const decision = decideSnapshotRefetch(
      { status: 'RUNNING', counts: counts(3) },
      { status: 'RUNNING', counts: counts(4) },
      1_000,
      6_001,
    );
    expect(decision).toEqual({ refetch: true, reason: 'progress-change' });
  });

  it('debounces count movement inside the window', () => {
    const decision = decideSnapshotRefetch(
      { status: 'RUNNING', counts: counts(3) },
      { status: 'RUNNING', counts: counts(4) },
      1_000,
      3_000,
    );
    expect(decision).toEqual({ refetch: false, reason: 'debounced' });
  });

  it('treats updatedAt movement as progress even when counts are unchanged', () => {
    const decision = decideSnapshotRefetch(
      { status: 'RUNNING', counts: counts(3), updatedAt: '2026-07-27T00:00:00Z' },
      { status: 'RUNNING', counts: counts(3), updatedAt: '2026-07-27T00:00:10Z' },
      null,
      10_000,
    );
    expect(decision).toEqual({ refetch: true, reason: 'progress-change' });
  });

  it('does nothing when the sample is identical', () => {
    const sample = { status: 'RUNNING', counts: counts(3) };
    expect(decideSnapshotRefetch(sample, { ...sample }, 1_000, 60_000)).toEqual({
      refetch: false,
      reason: 'none',
    });
  });
});

describe('isHeartbeatStale', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');

  it('is stale when non-terminal and the heartbeat is old or missing', () => {
    expect(isHeartbeatStale('RUNNING', '2026-07-27T11:57:00Z', now)).toBe(true); // 180s
    expect(isHeartbeatStale('REVIEWING', null, now)).toBe(true);
    expect(isHeartbeatStale('RUNNING', 'not-a-date', now)).toBe(true);
  });

  it('is fresh inside the 150s horizon', () => {
    expect(isHeartbeatStale('RUNNING', '2026-07-27T11:58:00Z', now)).toBe(false); // 120s
  });

  it('is never stale once the run is terminal', () => {
    expect(isHeartbeatStale('COMPLETED', null, now)).toBe(false);
    expect(isHeartbeatStale('CANCELLED', '2026-01-01T00:00:00Z', now)).toBe(false);
  });
});
