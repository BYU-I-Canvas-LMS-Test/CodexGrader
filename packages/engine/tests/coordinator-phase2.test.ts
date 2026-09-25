// Phase 2 coordinator regressions (plan §"Bugs and parity gaps"):
//   #5  phase rules from EVERY row (no early COMPLETED; approve-while-RUNNING;
//       a resumed POSTING run completes)
//   #6  ERROR rows are actionable: re-run (grade errors), re-approve (post errors)
//   #7  the prefix + approvedBy name the APPROVER
//   #2  edits refused on APPROVED/POSTED rows (row_locked)
//   #8  prep/profile snapshotted once at run start
//   #9  one active run per assignment (local + another laptop's fresh lock)
//   #13 racing resumes share one resume (single flight)
//       run-level pauses (usage limit / Codex sign-in) instead of mass ERROR
//       a fresh foreign lock refuses an interactive resume unless taken over

import { afterEach, describe, expect, it } from 'vitest';
import { AssignmentPrepSettingsSchema } from '@aigrader/shared';
import { EngineError, phaseFor } from '../src/coordinator/engine.js';
import { GradingCallError, type ModelCallFn } from '../src/llm/structured-client.js';
import {
  FakeCanvas,
  TEST_COURSE_KEY,
  buildEngine,
  defaultResources,
  graderOutputJson,
  makeGrade,
  makeProgressDoc,
  makeRunDoc,
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
const APPROVER = { canvasUserId: 44, name: 'Jane Approver' };
const DRAFT = { totalPoints: '15/20', assignmentFeedback: 'ok', rubrics: [] };

function twoStudentCanvas(): FakeCanvas {
  const canvas = new FakeCanvas();
  canvas.students = [student(1), student(2)];
  canvas.submissions = [textSubmission(1, '<p>one</p>'), textSubmission(2, '<p>two</p>')];
  return canvas;
}

/** Model whose Nth call (0-based) waits for release(n); others answer now. */
function gatedModel(gated: number[]) {
  let calls = 0;
  const gates = new Map<number, () => void>();
  const call: ModelCallFn = async () => {
    const n = calls++;
    if (gated.includes(n)) await new Promise<void>((resolve) => gates.set(n, resolve));
    return { text: graderOutputJson() };
  };
  return {
    call,
    get calls() {
      return calls;
    },
    release(n: number) {
      gates.get(n)?.();
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

let harness: TestEngineHarness | undefined;
afterEach(async () => {
  if (harness) await shutdown(harness);
  harness = undefined;
});

// ---------------------------------------------------------------- phaseFor --

describe('phaseFor (bug #5)', () => {
  const row = (status: Parameters<typeof phaseFor>[0][number]['status'], postedAt: string | null = null) => ({
    status,
    postedAt,
  });

  it('any in-flight row ⇒ RUNNING, even beside approved/posted rows', () => {
    expect(phaseFor([row('SCORING'), row('APPROVED'), row('POSTED', 'x')])).toBe('RUNNING');
    expect(phaseFor([row('PENDING')])).toBe('RUNNING');
  });

  it('approved-not-posted ⇒ POSTING; all posted ⇒ COMPLETED', () => {
    expect(phaseFor([row('APPROVED'), row('DRAFT')])).toBe('POSTING');
    expect(phaseFor([row('POSTED', 'x'), row('POSTED', 'y')])).toBe('COMPLETED');
  });

  it('drafts or errors left ⇒ REVIEWING (never COMPLETED early)', () => {
    expect(phaseFor([row('POSTED', 'x'), row('DRAFT')])).toBe('REVIEWING');
    expect(phaseFor([row('POSTED', 'x'), row('ERROR')])).toBe('REVIEWING');
    expect(phaseFor([])).toBe('REVIEWING');
  });
});

// ------------------------------------------------------------ approve flow --

describe('approve', () => {
  it('approving one row while another still drafts keeps the run RUNNING, then REVIEWING — not COMPLETED', async () => {
    const model = gatedModel([1]);
    harness = buildEngine({ canvas: twoStudentCanvas(), modelCall: model.call });
    const { engine, registry, canvas } = harness;
    const { runId } = await engine.startRun(START);
    const doc = () => registry.get(runId)!.session.document;

    await until(() => doc().grades.some((g) => g.status === 'DRAFT'), 'first draft');
    const drafted = doc().grades.find((g) => g.status === 'DRAFT')!.canvasUserId;
    const other = drafted === 1 ? 2 : 1;

    await engine.approve(runId, { userIds: [drafted], approver: APPROVER });
    await until(() => canvas.postedGrades.length === 1, 'first post');
    expect(doc().status).toBe('RUNNING'); // the other row is still in flight

    model.release(1);
    await engine.onIdle();
    expect(doc().status).toBe('REVIEWING'); // one DRAFT left ⇒ not COMPLETED
    expect(registry.get(runId)).toBeDefined();

    await engine.approve(runId, { userIds: [other], approver: APPROVER });
    await engine.onIdle();
    expect(registry.get(runId)).toBeUndefined(); // COMPLETED ⇒ unregistered
    expect((await engine.getSnapshot(runId)).status).toBe('COMPLETED');
  });

  it('records approvedBy (browser channel, rounded review seconds) and posts under the approver name (bug #7)', async () => {
    harness = buildEngine({ canvas: twoStudentCanvas() });
    const { engine, canvas, runStore } = harness;
    const { runId } = await engine.startRun(START);
    await engine.onIdle();

    await engine.approve(runId, { all: true, approver: APPROVER, reviewSeconds: { '1': 42.4 } });
    await engine.onIdle();

    for (const post of canvas.postedGrades) {
      expect((post.args as { comment: string }).comment.startsWith('[As Reviewed by Jane Approver]')).toBe(true);
    }
    const saved = runStore.docs.get(runId)!;
    const one = saved.grades.find((g) => g.canvasUserId === 1)!;
    const two = saved.grades.find((g) => g.canvasUserId === 2)!;
    expect(one.approvedBy).toMatchObject({ canvasUserId: 44, name: 'Jane Approver', channel: 'browser', reviewSeconds: 42 });
    expect(two.approvedBy?.reviewSeconds).toBeUndefined();
  });

  it('a failed POST lands errorKind "post"; re-approving retries the post without re-grading (bug #6)', async () => {
    const canvas = twoStudentCanvas();
    canvas.failPostGradeFor.add(1);
    harness = buildEngine({ canvas });
    const { engine, registry, modelCalls } = harness;
    const { runId } = await engine.startRun(START);
    await engine.onIdle();

    await engine.approve(runId, { all: true, approver: APPROVER });
    await engine.onIdle();
    const doc = registry.get(runId)!.session.document;
    const failed = doc.grades.find((g) => g.canvasUserId === 1)!;
    expect(failed.status).toBe('ERROR');
    expect(failed.errorKind).toBe('post');
    expect(doc.status).toBe('REVIEWING');

    canvas.failPostGradeFor.clear();
    const { approved } = await engine.approve(runId, { userIds: [1], approver: APPROVER });
    expect(approved).toBe(1);
    await engine.onIdle();
    expect(modelCalls).toHaveLength(2); // never re-graded
    expect(canvas.postedGrades.filter((p) => p.userId === 1)).toHaveLength(1);
    expect(registry.get(runId)).toBeUndefined(); // all posted ⇒ COMPLETED
  });

  it('a grading ERROR is not approvable (re-run it instead)', async () => {
    let n = 0;
    harness = buildEngine({
      canvas: twoStudentCanvas(),
      modelCall: async () => {
        if (n++ === 0) throw Object.assign(new Error('bad request'), { status: 400 });
        return { text: graderOutputJson() };
      },
    });
    const { engine, registry } = harness;
    const { runId } = await engine.startRun(START);
    await engine.onIdle();
    const errored = registry.get(runId)!.session.document.grades.find((g) => g.status === 'ERROR')!;
    expect(errored.errorKind).toBe('grade');
    const { approved } = await engine.approve(runId, { userIds: [errored.canvasUserId], approver: APPROVER });
    expect(approved).toBe(0);
  });
});

// ------------------------------------------------- edit / revert / re-run --

describe('edit, revert, re-run', () => {
  it('edits on POSTED rows are refused with row_locked (bug #2)', async () => {
    const canvas = twoStudentCanvas();
    harness = buildEngine({ canvas });
    harness.runStore.docs.set(
      'run1',
      makeRunDoc({
        status: 'REVIEWING',
        grades: [
          makeGrade({ canvasUserId: 1, status: 'POSTED', aiDraft: DRAFT, postedAt: '2026-06-10T15:30:00.000Z' }),
          makeGrade({ canvasUserId: 2, status: 'DRAFT', aiDraft: DRAFT }),
        ],
      }),
    );
    harness.progressStore.docs.set('run1', makeProgressDoc({ status: 'REVIEWING' }));

    await expect(
      harness.engine.edit('run1', { canvasUserId: 1, facultyEdited: DRAFT }),
    ).rejects.toMatchObject({ code: 'row_locked' });
    await expect(
      harness.engine.edit('run1', { canvasUserId: 2, facultyEdited: DRAFT, source: 'codex-chat' }),
    ).resolves.toBeUndefined();
    const row = harness.registry.get('run1')!.session.document.grades.find((g) => g.canvasUserId === 2)!;
    expect(row.status).toBe('EDITED');
    expect(row.editSource).toBe('codex-chat');
  });

  it('re-run: a grade ERROR re-drafts; a kept faculty edit is flagged stale; POSTED rows are skipped', async () => {
    let fail = true;
    harness = buildEngine({
      canvas: twoStudentCanvas(),
      modelCall: async () => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error('bad request'), { status: 400 });
        }
        return { text: graderOutputJson() };
      },
    });
    const { engine, registry, modelCalls } = harness;
    const { runId } = await engine.startRun(START);
    await engine.onIdle();
    const doc = () => registry.get(runId)!.session.document;
    const errored = doc().grades.find((g) => g.status === 'ERROR')!.canvasUserId;
    const drafted = errored === 1 ? 2 : 1;

    const edited = { ...DRAFT, assignmentFeedback: 'teacher wrote this' };
    await engine.edit(runId, { canvasUserId: drafted, facultyEdited: edited });

    const { requeued } = await engine.rerun(runId, { userIds: [errored, drafted] });
    expect(requeued).toBe(2);
    await engine.onIdle();
    expect(modelCalls).toHaveLength(4);

    const fixed = doc().grades.find((g) => g.canvasUserId === errored)!;
    expect(fixed.status).toBe('DRAFT');
    expect(fixed.errorKind).toBeUndefined();

    const kept = doc().grades.find((g) => g.canvasUserId === drafted)!;
    expect(kept.status).toBe('EDITED');
    expect(kept.staleEdit).toBe(true);
    expect(kept.facultyEdited).toMatchObject({ assignmentFeedback: 'teacher wrote this' });
    expect(doc().status).toBe('REVIEWING');

    // Revert to AI: the edit and its flags go; the AI draft stays.
    await engine.revert(runId, { canvasUserId: drafted });
    const reverted = doc().grades.find((g) => g.canvasUserId === drafted)!;
    expect(reverted.status).toBe('DRAFT');
    expect(reverted.facultyEdited).toBeNull();
    expect(reverted.staleEdit).toBeUndefined();
    expect(reverted.aiDraft).not.toBeNull();

    // Approved/posted rows are never re-graded.
    await engine.approve(runId, { userIds: [errored], approver: APPROVER });
    await engine.onIdle();
    expect((await engine.rerun(runId, { userIds: [errored] })).requeued).toBe(0);
  });
});

// ------------------------------------------------------- run-start inputs --

describe('startRun', () => {
  it('snapshots prep + profile once at run start (bug #8)', async () => {
    let prepReads = 0;
    harness = buildEngine({
      canvas: twoStudentCanvas(),
      clients: (base) => ({
        ...base,
        resources: {
          ...defaultResources,
          getPrep: async () => {
            prepReads++;
            return AssignmentPrepSettingsSchema.parse({ customInstructions: 'Be kind.', shareRubric: false });
          },
        },
      }),
    });
    const { engine, runStore } = harness;
    const { runId } = await engine.startRun(START);
    await engine.onIdle();
    expect(prepReads).toBe(1); // not once per student
    const snap = runStore.docs.get(runId)!.prepSnapshot!;
    expect(snap.customInstructions).toBe('Be kind.');
    expect(snap.shareRubric).toBe(false);
    expect(snap.shareInstructions).toBe(true);
    expect(typeof snap.profileText).toBe('string');
  });

  it('refuses a second active run on the same assignment, allows one once the first is reviewing (bug #9)', async () => {
    const model = gatedModel([0]);
    harness = buildEngine({ canvas: twoStudentCanvas(), modelCall: model.call });
    const { engine } = harness;
    await engine.startRun(START);
    await expect(engine.startRun(START)).rejects.toMatchObject({ code: 'run_already_active' });

    await until(() => model.calls >= 1, 'the gated model call');
    model.release(0);
    await engine.onIdle();
    await expect(engine.startRun(START)).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it("refuses when another laptop's newest run on the assignment holds a fresh lock", async () => {
    harness = buildEngine({ canvas: twoStudentCanvas() });
    harness.runStore.docs.set(
      'elsewhere',
      makeRunDoc({
        runId: 'elsewhere',
        status: 'RUNNING',
        lock: { owner: 'other-laptop:abc', ownerName: 'TA', heartbeatUtc: harness.clock.now().toISOString() },
      }),
    );
    await expect(harness.engine.startRun(START)).rejects.toBeInstanceOf(EngineError);
    await expect(harness.engine.startRun(START)).rejects.toMatchObject({ code: 'run_already_active' });
  });
});

// ------------------------------------------------------------------ resume --

describe('resume', () => {
  function seedReviewing(h: TestEngineHarness, extra: Parameters<typeof makeRunDoc>[0] = {}) {
    h.runStore.docs.set(
      'run1',
      makeRunDoc({
        status: 'RUNNING',
        grades: [makeGrade({ canvasUserId: 1, status: 'PENDING' }), makeGrade({ canvasUserId: 2, status: 'PENDING' })],
        ...extra,
      }),
    );
    h.progressStore.docs.set('run1', makeProgressDoc());
  }

  it('racing resumes share one resume instead of failing "already registered" (bug #13)', async () => {
    harness = buildEngine({ canvas: twoStudentCanvas() });
    seedReviewing(harness);
    const [a, b] = await Promise.all([harness.engine.resume('run1'), harness.engine.resume('run1')]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ outcome: 'resumed', requeued: 2 });
    await harness.engine.onIdle();
    expect(harness.modelCalls).toHaveLength(2);
  });

  it('a resumed POSTING run whose posts all landed completes (bug #5)', async () => {
    const canvas = twoStudentCanvas();
    harness = buildEngine({ canvas });
    harness.runStore.docs.set(
      'run1',
      makeRunDoc({
        status: 'POSTING',
        grades: [
          makeGrade({ canvasUserId: 1, status: 'POSTED', aiDraft: DRAFT, postedAt: '2026-06-10T15:10:00.000Z' }),
          makeGrade({ canvasUserId: 2, status: 'POSTED', aiDraft: DRAFT, postedAt: '2026-06-10T15:11:00.000Z' }),
        ],
      }),
    );
    harness.progressStore.docs.set('run1', makeProgressDoc({ status: 'POSTING' }));
    await harness.engine.resume('run1');
    expect(harness.registry.get('run1')).toBeUndefined();
    expect(harness.runStore.docs.get('run1')!.status).toBe('COMPLETED');
  });

  it('refuses an interactive resume of a run another computer holds, unless taken over', async () => {
    harness = buildEngine({ canvas: twoStudentCanvas() });
    seedReviewing(harness, {
      lock: { owner: 'other-laptop:abc', ownerName: 'TA', heartbeatUtc: harness.clock.now().toISOString() },
    });
    await expect(harness.engine.resume('run1')).rejects.toMatchObject({ code: 'run_locked_elsewhere' });
    await expect(harness.engine.resume('run1', { respectLock: true })).resolves.toEqual({ outcome: 'skipped_lock' });
    await expect(harness.engine.resume('run1', { takeOver: true })).resolves.toMatchObject({ outcome: 'resumed' });
  });

  it('a run paused until a future usage reset stays paused on resume, and resumes on request', async () => {
    harness = buildEngine({ canvas: twoStudentCanvas() });
    const until = new Date(harness.clock.ms + 60 * 60 * 1000).toISOString();
    seedReviewing(harness, { pausedReason: 'usage_limit', pausedUntil: until, pausedMessage: 'limit' });

    await expect(harness.engine.resume('run1')).resolves.toMatchObject({ outcome: 'resumed', requeued: 0 });
    expect(harness.modelCalls).toHaveLength(0);
    expect(harness.registry.get('run1')!.paused?.reason).toBe('usage_limit');

    await expect(harness.engine.resume('run1')).resolves.toMatchObject({ outcome: 'resumed', requeued: 2 });
    await harness.engine.onIdle();
    const doc = harness.registry.get('run1')!.session.document;
    expect(doc.pausedReason).toBeUndefined();
    expect(doc.status).toBe('REVIEWING');
  });
});

// ------------------------------------------------------------------- pause --

describe('run-level pause', () => {
  it('a usage limit pauses the run (rows back to PENDING, not ERROR); resume re-grades them', async () => {
    let limited = true;
    harness = buildEngine({
      canvas: twoStudentCanvas(),
      modelCall: async () => {
        if (limited) {
          throw new GradingCallError('usage limit', {
            retryable: false,
            kind: 'usage_limit',
            resetsAt: '2026-06-10T21:00:00.000Z',
          });
        }
        return { text: graderOutputJson() };
      },
    });
    const { engine, registry, runStore } = harness;
    const { runId } = await engine.startRun(START);
    await engine.onIdle();

    const live = registry.get(runId)!;
    expect(live.paused?.reason).toBe('usage_limit');
    const doc = live.session.document;
    expect(doc.grades.every((g) => g.status === 'PENDING')).toBe(true);
    expect(doc.status).toBe('RUNNING');
    const saved = runStore.docs.get(runId)!;
    expect(saved.pausedReason).toBe('usage_limit');
    expect(saved.pausedUntil).toBe('2026-06-10T21:00:00.000Z');
    expect(saved.pausedMessage).toContain('2026-06-10T21:00:00.000Z');

    limited = false;
    await expect(engine.resume(runId)).resolves.toMatchObject({ outcome: 'resumed', requeued: 2 });
    await engine.onIdle();
    expect(doc.grades.every((g) => g.status === 'DRAFT')).toBe(true);
    expect(doc.pausedReason).toBeUndefined();
    expect(doc.status).toBe('REVIEWING');
  });

  it('an expired Codex sign-in pauses with codex_auth and no automatic resume time', async () => {
    harness = buildEngine({
      canvas: twoStudentCanvas(),
      modelCall: async () => {
        throw new GradingCallError('auth', { retryable: false, kind: 'auth' });
      },
    });
    const { runId } = await harness.engine.startRun(START);
    await harness.engine.onIdle();
    const doc = harness.registry.get(runId)!.session.document;
    expect(doc.pausedReason).toBe('codex_auth');
    expect(doc.pausedUntil).toBeUndefined();
    expect(doc.pausedMessage).toContain('codex login');
  });
});

// --------------------------------------------------------------- retention --

describe('retention sweep wiring (bug #15)', () => {
  it('listing runs fires the course sweep in the background, at most once per interval', async () => {
    let sweeps = 0;
    harness = buildEngine({
      clients: (base) => ({
        ...base,
        runStore: Object.assign(base.runStore, {
          cleanup: async () => {
            sweeps++;
          },
        }),
      }),
    });
    await harness.engine.listRuns({ courseKey: TEST_COURSE_KEY });
    await harness.engine.listRuns({ courseKey: TEST_COURSE_KEY });
    await harness.engine.onIdle();
    expect(sweeps).toBe(1);

    harness.clock.advance(7 * 60 * 60 * 1000);
    await harness.engine.listRuns({ courseKey: TEST_COURSE_KEY });
    await harness.engine.onIdle();
    expect(sweeps).toBe(2);
  });
});

// ---------------------------------------------------------------- activity --

describe('engine.activity (idle shutdown / sleep inhibit)', () => {
  it('is busy while drafting, idle once reviewing, waiting while a usage-limit pause is pending', async () => {
    const model = gatedModel([0]);
    harness = buildEngine({ canvas: twoStudentCanvas(), modelCall: model.call });
    const { engine } = harness;
    expect(engine.activity()).toEqual({ busy: false, waiting: false, liveRuns: 0 });

    const { runId } = await engine.startRun(START);
    expect(engine.activity().busy).toBe(true);

    await until(() => model.calls >= 1, 'the gated model call');
    model.release(0);
    await engine.onIdle();
    expect(engine.activity()).toEqual({ busy: false, waiting: false, liveRuns: 1 });
    expect(runId).toBeTruthy();
  });

  it('a usage-limit pause is "waiting", not busy', async () => {
    harness = buildEngine({
      canvas: twoStudentCanvas(),
      modelCall: async () => {
        throw new GradingCallError('limit', {
          retryable: false,
          kind: 'usage_limit',
          resetsAt: '2026-06-10T21:00:00.000Z',
        });
      },
    });
    await harness.engine.startRun(START);
    await harness.engine.onIdle();
    expect(harness.engine.activity()).toEqual({ busy: false, waiting: true, liveRuns: 1 });
  });
});

// ------------------------------------------------------ shutdown + token fix --

describe('shutdown and pause recovery', () => {
  it('the shutdown checkpoint releases the advisory lock', async () => {
    harness = buildEngine({ canvas: twoStudentCanvas() });
    const { runId } = await harness.engine.startRun(START);
    await harness.engine.onIdle();
    expect(harness.runStore.docs.get(runId)!.lock).not.toBeNull();
    await harness.registry.finalCheckpointAll(5_000);
    expect(harness.runStore.docs.get(runId)!.lock).toBeNull();
    harness = undefined; // already disposed
  });

  it('resumePaused(canvas_auth) lifts only token pauses', async () => {
    let fail = true;
    const { CanvasError } = await import('@aigrader/canvas');
    const canvas = twoStudentCanvas();
    const realGetSubmission = canvas.getSubmission.bind(canvas);
    canvas.getSubmission = async (...args: Parameters<FakeCanvas['getSubmission']>) => {
      if (fail) throw new CanvasError(401, 'https://x/api/v1/courses/77/submissions', 'unauthorized');
      return realGetSubmission(...args);
    };
    harness = buildEngine({ canvas });
    const { runId } = await harness.engine.startRun(START);
    await harness.engine.onIdle();
    expect(harness.registry.get(runId)!.paused?.reason).toBe('canvas_auth');

    expect(await harness.engine.resumePaused('codex_auth')).toEqual([]);
    fail = false;
    expect(await harness.engine.resumePaused('canvas_auth')).toEqual([runId]);
    await harness.engine.onIdle();
    const doc = harness.registry.get(runId)!.session.document;
    expect(doc.grades.every((g) => g.status === 'DRAFT')).toBe(true);
  });
});

describe('auto-resume timer', () => {
  it('a reset months away does not fire at once (setTimeout overflow guard)', async () => {
    harness = buildEngine({
      canvas: twoStudentCanvas(),
      modelCall: async () => {
        throw new GradingCallError('limit', {
          retryable: false,
          kind: 'usage_limit',
          // ~106 days after the test clock — beyond setTimeout's 24.8-day cap.
          resetsAt: '2026-09-24T21:00:00.000Z',
        });
      },
    });
    const { runId } = await harness.engine.startRun(START);
    await harness.engine.onIdle();
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.modelCalls).toHaveLength(2); // not re-queued in a loop
    expect(harness.registry.get(runId)!.paused?.reason).toBe('usage_limit');
  });
});
