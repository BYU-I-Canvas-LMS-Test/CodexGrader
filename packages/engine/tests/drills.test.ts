// Phase 2 exit drills, at the engine seam (one shared fake Canvas folder,
// one shared clock, engines standing in for server processes / laptops):
//   1. kill mid-run → restart → the resume sweep finishes the run
//   2. sleep mid-run (no other computer) → the run just continues
//   3. two laptops: B opens the run while A sleeps; A wakes and must NOT
//      overwrite B's checkpoint, and A can't reopen it without taking over
//   4. clean shutdown releases the lock → the other laptop opens it at once

import { afterEach, describe, expect, it } from 'vitest';
import type { RunProgressDoc } from '@aigrader/shared';
import { LocalProgressStore } from '../src/progress/progress-writer.js';
import { sweep } from '../src/coordinator/sweeper.js';
import type { ModelCallFn } from '../src/llm/structured-client.js';
import {
  FakeCanvas,
  FakeRunStore,
  TEST_COURSE_KEY,
  TestClock,
  buildEngine,
  graderOutputJson,
  shutdown,
  student,
  textSubmission,
  type TestEngineHarness,
} from './engine-helpers.js';

const START = {
  courseKey: TEST_COURSE_KEY,
  faculty: { canvasUserId: 9, name: 'John Doe' },
  target: { kind: 'assignment' as const, assignmentId: 501 },
};
const DRAFT = { totalPoints: '15/20', assignmentFeedback: 'edited', rubrics: [] };

function canvasWith(n: number): FakeCanvas {
  const canvas = new FakeCanvas();
  canvas.students = Array.from({ length: n }, (_, i) => student(i + 1));
  canvas.submissions = canvas.students.map((s) => textSubmission(s.id, `<p>work ${s.id}</p>`));
  return canvas;
}

/** A model that hangs every call until release() (or forever). */
function hangingModel() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const call: ModelCallFn = async (req) => {
    calls++;
    await Promise.race([
      gate,
      new Promise<void>((_, reject) =>
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
    ]);
    return { text: graderOutputJson() };
  };
  return {
    call,
    release: () => release(),
    get calls() {
      return calls;
    },
  };
}

async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const harnesses: TestEngineHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    for (const live of h.registry.list()) await h.registry.remove(live.runId);
  }
});

function machine(opts: Parameters<typeof buildEngine>[0]): TestEngineHarness {
  const h = buildEngine({ heartbeatMs: 0, ...opts });
  harnesses.push(h);
  return h;
}

describe('drill: kill mid-run, then restart', () => {
  it('the restarted server resumes the run from active-runs and finishes it', async () => {
    const clock = new TestClock();
    const runStore = new FakeRunStore();
    const canvas = canvasWith(3);
    let persisted: RunProgressDoc[] = [];
    const model = hangingModel();

    // Process 1 starts grading, then "crashes" mid-run (never disposes).
    const first = machine({
      canvas,
      clock,
      runStore,
      instanceId: 'laptop:process-1',
      modelCall: model.call,
      progressStore: new LocalProgressStore({ persist: (live) => void (persisted = structuredClone(live)) }),
    });
    const { runId } = await first.engine.startRun(START);
    await until(() => model.calls >= 3, 'all three model calls in flight');
    expect(persisted.map((r) => r.runId)).toEqual([runId]); // on disk
    first.registry.get(runId)!.controller.abort(); // the process dies
    first.registry.get(runId)!.cancelRequested = true;

    // Process 2 boots from the persisted list.
    clock.advance(10_000);
    const second = machine({
      canvas,
      clock,
      runStore,
      instanceId: 'laptop:process-2',
      progressStore: new LocalProgressStore({ initial: persisted }),
    });
    const sweepNow = () =>
      sweep({
        engine: second.engine,
        progressStore: second.progressStore,
        registry: second.registry,
        now: clock.now,
        warn: () => {},
      });

    // Right after the crash the dead process's lock still looks fresh.
    expect((await sweepNow()).skipped).toEqual([{ runId, reason: 'fresh_heartbeat' }]);

    // A few minutes later the periodic sweep takes it.
    clock.advance(4 * 60_000);
    const report = await sweepNow();
    expect(report.resumed).toEqual([runId]);
    await second.engine.onIdle();

    const doc = second.registry.get(runId)!.session.document;
    expect(doc.grades.map((g) => g.status)).toEqual(['DRAFT', 'DRAFT', 'DRAFT']);
    expect(doc.status).toBe('REVIEWING');
    expect(runStore.docs.get(runId)!.lock?.owner).toBe('laptop:process-2');
  });
});

describe('drill: sleep mid-run (no other computer)', () => {
  it('after waking, the run checks the lock, finds it still its own, and continues', async () => {
    const clock = new TestClock();
    const runStore = new FakeRunStore();
    const model = hangingModel();
    const laptop = machine({ canvas: canvasWith(2), clock, runStore, instanceId: 'laptop:a', modelCall: model.call });
    const { runId } = await laptop.engine.startRun(START);
    await until(() => model.calls >= 2, 'model calls in flight');

    clock.advance(45 * 60_000); // the lid was closed for 45 minutes
    model.release();
    await laptop.engine.onIdle();
    await laptop.registry.get(runId)!.session.flush();

    expect(laptop.registry.get(runId)!.session.isEvicted).toBe(false);
    const saved = runStore.docs.get(runId)!;
    expect(saved.grades.every((g) => g.status === 'DRAFT')).toBe(true);
    expect(saved.lock?.owner).toBe('laptop:a');
  });
});

describe('drill: two laptops', () => {
  async function reviewingRunOnA() {
    const clock = new TestClock();
    const runStore = new FakeRunStore();
    const canvas = canvasWith(2);
    const a = machine({ canvas, clock, runStore, instanceId: 'laptop:a' });
    const b = machine({ canvas, clock, runStore, instanceId: 'laptop:b' });
    const { runId } = await a.engine.startRun(START);
    await a.engine.onIdle();
    return { clock, runStore, a, b, runId };
  }

  it('B cannot open a run A is actively holding without an explicit take-over', async () => {
    const { a, b, runId } = await reviewingRunOnA();
    await a.registry.get(runId)!.session.flush(); // fresh heartbeat
    await b.engine.adopt(runId, TEST_COURSE_KEY);
    await expect(b.engine.resume(runId)).rejects.toMatchObject({ code: 'run_locked_elsewhere' });
  });

  it('B opens the run while A sleeps; waking A does not overwrite B and stops working on it', async () => {
    const { clock, runStore, a, b, runId } = await reviewingRunOnA();

    // A goes to sleep; its lock goes stale.
    clock.advance(10 * 60_000);

    // B opens the run (stale lock ⇒ no take-over needed) and edits row 1.
    await b.engine.adopt(runId, TEST_COURSE_KEY);
    await expect(b.engine.resume(runId)).resolves.toMatchObject({ outcome: 'resumed' });
    await b.engine.edit(runId, { canvasUserId: 1, facultyEdited: { ...DRAFT, assignmentFeedback: 'from B' } });
    await b.registry.get(runId)!.session.flush();
    expect(runStore.docs.get(runId)!.lock?.owner).toBe('laptop:b');

    // A wakes up with an unsaved edit of row 2 and tries to checkpoint.
    clock.advance(1_000);
    const aSession = a.registry.get(runId)!.session;
    aSession.saveFacultyEdit(2, { ...DRAFT, assignmentFeedback: 'from A' });
    const savesBefore = runStore.saves.length;
    await aSession.flush();

    expect(aSession.isEvicted).toBe(true);
    expect(runStore.saves.length).toBe(savesBefore); // A wrote nothing
    const saved = runStore.docs.get(runId)!;
    expect(saved.lock?.owner).toBe('laptop:b');
    expect(saved.grades.find((g) => g.canvasUserId === 1)!.facultyEdited).toMatchObject({ assignmentFeedback: 'from B' });
    expect(saved.grades.find((g) => g.canvasUserId === 2)!.facultyEdited).toBeNull();

    // A drops the run and leaves it out of its own resume sweep …
    await until(() => a.progressStore.docs.get(runId)?.adopted === true, 'A to drop the run');
    expect(a.registry.get(runId)).toBeUndefined();
    expect(await a.progressStore.listLive()).toEqual([]);
    // … and reopening it on A needs an explicit take-over while B holds it.
    await expect(a.engine.resume(runId)).rejects.toMatchObject({ code: 'run_locked_elsewhere' });
  });

  it("a clean shutdown releases A's lock, so B opens the run immediately", async () => {
    const { a, b, runId } = await reviewingRunOnA();
    await a.registry.finalCheckpointAll(5_000);
    await b.engine.adopt(runId, TEST_COURSE_KEY);
    await expect(b.engine.resume(runId)).resolves.toMatchObject({ outcome: 'resumed' });
    await shutdown(b);
  });
});

describe('drill: racing approvals', () => {
  it('approve(one) racing approve(all) posts each student exactly once', async () => {
    const canvas = canvasWith(3);
    const h = machine({ canvas });
    const { runId } = await h.engine.startRun(START);
    await h.engine.onIdle();
    const approver = { canvasUserId: 44, name: 'Jane Approver' };
    const [one, all] = await Promise.all([
      h.engine.approve(runId, { userIds: [1], approver }),
      h.engine.approve(runId, { all: true, approver }),
    ]);
    await h.engine.onIdle();
    expect(one.approved + all.approved).toBe(3);
    expect(canvas.postedGrades.map((p) => p.userId).sort()).toEqual([1, 2, 3]);
  });
});
