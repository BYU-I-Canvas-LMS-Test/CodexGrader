// Resume-sweep tests (the startup / periodic crash-recovery pass):
// stale-heartbeat runs resume through reconcile; fresh heartbeats and
// locally-live runs are skipped; a fresh Canvas-doc RunLock held by ANOTHER
// owner is respected; cancelRequested on a dead owner finalizes CANCELLED;
// per-run failures never stop the sweep.

import { describe, expect, it } from 'vitest';
import { sweep } from '../src/coordinator/sweeper.js';
import {
  FakeCanvas,
  buildEngine,
  makeGrade,
  makeProgressDoc,
  makeRunDoc,
  shutdown,
  student,
  textSubmission,
  type TestEngineHarness,
} from './engine-helpers.js';

// TestClock base is 16:00Z. Heartbeats: 15:00 = 3600s old (stale ≫ 150s);
// 15:59 = 60s old (fresh).
const STALE_HEARTBEAT = '2026-06-10T15:00:00.000Z';
const FRESH_HEARTBEAT = '2026-06-10T15:59:00.000Z';

function seedAssignmentRun(
  harness: TestEngineHarness,
  runId: string,
  opts: {
    heartbeatAt?: string;
    cancelRequested?: boolean;
    lock?: { owner: string; heartbeatUtc: string } | null;
  } = {},
): void {
  harness.canvas.students = [student(1)];
  harness.canvas.submissions = [textSubmission(1, '<p>one</p>')];
  harness.runStore.docs.set(
    runId,
    makeRunDoc({
      runId,
      status: 'RUNNING',
      updatedAt: STALE_HEARTBEAT,
      grades: [makeGrade({ canvasUserId: 1, status: 'SCORING' })],
      lock: opts.lock
        ? { owner: opts.lock.owner, ownerName: 'John Doe', heartbeatUtc: opts.lock.heartbeatUtc }
        : null,
    }),
  );
  harness.progressStore.docs.set(
    runId,
    makeProgressDoc({
      runId,
      cancelRequested: opts.cancelRequested ?? false,
      worker: {
        owner: 'rev-dead:xyz',
        heartbeatAt: opts.heartbeatAt ?? STALE_HEARTBEAT,
        resumeCount: 0,
      },
    }),
  );
}

function runSweep(harness: TestEngineHarness) {
  return sweep({
    engine: harness.engine,
    progressStore: harness.progressStore,
    registry: harness.registry,
    now: harness.clock.now,
    warn: () => {},
  });
}

describe('sweep', () => {
  it('resumes a stale non-terminal run (SCORING row re-queued and re-drafted)', async () => {
    const harness = buildEngine({});
    seedAssignmentRun(harness, 'run1', { heartbeatAt: STALE_HEARTBEAT });

    const report = await runSweep(harness);
    expect(report.scanned).toBe(1);
    expect(report.resumed).toEqual(['run1']);

    await harness.engine.onIdle();
    const doc = harness.registry.get('run1')!.session.document;
    expect(doc.grades[0]!.status).toBe('DRAFT');
    expect(doc.status).toBe('REVIEWING');
    expect(harness.progressStore.docs.get('run1')!.worker.resumeCount).toBe(1);

    await shutdown(harness);
  });

  it('a missing heartbeat counts as stale (first progress write never landed)', async () => {
    const harness = buildEngine({});
    seedAssignmentRun(harness, 'run1');
    harness.progressStore.docs.get('run1')!.worker.heartbeatAt = null;

    const report = await runSweep(harness);
    expect(report.resumed).toEqual(['run1']);
    await shutdown(harness);
  });

  it('skips runs with a fresh worker heartbeat (owner is alive elsewhere)', async () => {
    const harness = buildEngine({});
    seedAssignmentRun(harness, 'run1', { heartbeatAt: FRESH_HEARTBEAT });

    const report = await runSweep(harness);
    expect(report.resumed).toEqual([]);
    expect(report.skipped).toEqual([{ runId: 'run1', reason: 'fresh_heartbeat' }]);
    expect(harness.registry.get('run1')).toBeUndefined();
  });

  it('skips runs already live in THIS process', async () => {
    const canvas = new FakeCanvas();
    canvas.students = [student(1)];
    canvas.submissions = [textSubmission(1, '<p>one</p>')];
    const harness = buildEngine({ canvas });
    const { runId } = await harness.engine.startRun({
      courseKey: 'school.instructure.com#77',
      faculty: { canvasUserId: 9, name: 'John Doe' },
      target: { kind: 'assignment', assignmentId: 501 },
    });
    await harness.engine.onIdle();

    const report = await runSweep(harness);
    expect(report.skipped).toContainEqual({ runId, reason: 'live_here' });
    expect(report.resumed).toEqual([]);
    await shutdown(harness);
  });

  it('respects a FRESH Canvas-doc RunLock held by another owner (revision overlap)', async () => {
    const harness = buildEngine({});
    seedAssignmentRun(harness, 'run1', {
      heartbeatAt: STALE_HEARTBEAT, // progress mirror says stale…
      lock: { owner: 'rev-other:abc', heartbeatUtc: FRESH_HEARTBEAT }, // …but the doc (truth) is fresh
    });

    const report = await runSweep(harness);
    expect(report.skipped).toEqual([{ runId: 'run1', reason: 'lock' }]);
    expect(harness.registry.get('run1')).toBeUndefined();
  });

  it('a STALE Canvas-doc RunLock does not block the takeover', async () => {
    const harness = buildEngine({});
    seedAssignmentRun(harness, 'run1', {
      heartbeatAt: STALE_HEARTBEAT,
      lock: { owner: 'rev-other:abc', heartbeatUtc: STALE_HEARTBEAT },
    });

    const report = await runSweep(harness);
    expect(report.resumed).toEqual(['run1']);
    await shutdown(harness);
  });

  it('finalizes CANCELLED when the dead owner left cancelRequested behind', async () => {
    const harness = buildEngine({});
    seedAssignmentRun(harness, 'run1', { cancelRequested: true });

    const report = await runSweep(harness);
    expect(report.finalizedCancelled).toEqual(['run1']);

    // No re-queued grading, terminal doc + progress.
    expect(harness.modelCalls).toHaveLength(0);
    expect(harness.runStore.docs.get('run1')!.status).toBe('CANCELLED');
    const progress = harness.progressStore.docs.get('run1')!;
    expect(progress.status).toBe('CANCELLED');
    expect(harness.registry.get('run1')).toBeUndefined();
  });

  it('contains per-run failures and sweeps the rest', async () => {
    const harness = buildEngine({});
    // run1 has progress but NO checkpoint document → run_document_missing.
    harness.progressStore.docs.set('broken', makeProgressDoc({ runId: 'broken' }));
    seedAssignmentRun(harness, 'run1');

    const report = await runSweep(harness);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ runId: 'broken' });
    expect(report.resumed).toEqual(['run1']);
    await shutdown(harness);
  });

  it('terminal runs never enter the sweep', async () => {
    const harness = buildEngine({});
    seedAssignmentRun(harness, 'run1');
    harness.progressStore.docs.get('run1')!.status = 'COMPLETED';

    const report = await runSweep(harness);
    expect(report.scanned).toBe(0);
  });
});
