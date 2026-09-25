// RunSession checkpoint-policy tests: the debounce tiers (grade 15s /
// 25-dirty, edits ~3s), IMMEDIATE flushes on status transitions and posts,
// RunLock refresh on every flush, and dispose-as-final-flush. Ports the
// behavioral contract of C# RunSession.cs onto the injectable-clock port.

import { describe, expect, it } from 'vitest';
import {
  EDIT_FLUSH_DELAY_MS,
  HEARTBEAT_FLUSH_MS,
  PROGRESS_FLUSH_DIRTY_COUNT,
  PROGRESS_FLUSH_INTERVAL_MS,
  RowLockedError,
  RunSession,
} from '../src/coordinator/run-session.js';
import { FakeRunStore, TestClock, makeGrade, makeRunDoc } from './engine-helpers.js';

function makeSession(rows = 3) {
  const clock = new TestClock();
  const store = new FakeRunStore();
  const doc = makeRunDoc({
    grades: Array.from({ length: rows }, (_, i) => makeGrade({ canvasUserId: i + 1 })),
  });
  const session = new RunSession({
    document: doc,
    store,
    ownerId: 'rev-1:abc',
    now: clock.now,
    startLoop: false, // tests drive tick() against the injected clock
    warn: () => {},
  });
  return { clock, store, doc, session };
}

describe('RunSession debounce tiers', () => {
  it('grade progress does NOT flush before the 15s window', async () => {
    const { clock, store, session } = makeSession();
    // Baseline flush (the seed checkpoint every real run starts with) — the
    // C# debounce measures "15s since the LAST flush".
    await session.flush();
    store.saves.length = 0;

    session.updateGrade(1, (g) => {
      g.status = 'EXTRACTING';
    });

    clock.advance(PROGRESS_FLUSH_INTERVAL_MS - 1000);
    await session.tick();
    expect(store.saves).toHaveLength(0);
  });

  it('grade progress flushes once the 15s window elapses', async () => {
    const { clock, store, session } = makeSession();
    await session.flush();
    store.saves.length = 0;

    session.updateGrade(1, (g) => {
      g.status = 'EXTRACTING';
    });

    clock.advance(PROGRESS_FLUSH_INTERVAL_MS);
    await session.tick();
    expect(store.saves).toHaveLength(1);
    expect(store.lastSave.grades[0]!.status).toBe('EXTRACTING');

    // Nothing new dirty → the next tick does not flush again.
    clock.advance(PROGRESS_FLUSH_INTERVAL_MS);
    await session.tick();
    expect(store.saves).toHaveLength(1);
  });

  it('25 dirty items force a flush without waiting for the interval', async () => {
    const { clock, store, session } = makeSession(30);
    for (let i = 1; i <= PROGRESS_FLUSH_DIRTY_COUNT; i++) {
      session.updateGrade(i, (g) => {
        g.status = 'EXTRACTING';
      });
    }
    clock.advance(1000); // one loop tick, well inside the 15s window
    await session.tick();
    expect(store.saves).toHaveLength(1);
  });

  it('faculty edits flush within ~3 seconds (the expensive-to-lose tier)', async () => {
    const { clock, store, session } = makeSession();
    session.updateGrade(1, (g) => {
      g.status = 'DRAFT';
      g.aiDraft = { totalPoints: '5/10', assignmentFeedback: 'ok', rubrics: [] };
    });
    // Clear the pending dirty state so the edit tier is what's measured.
    await session.flush();
    store.saves.length = 0;

    session.saveFacultyEdit(1, { totalPoints: '7/10', assignmentFeedback: 'better', rubrics: [] });
    expect(session.document.grades[0]!.status).toBe('EDITED');

    clock.advance(2000);
    await session.tick();
    expect(store.saves).toHaveLength(0); // not yet due

    clock.advance(1000); // 3s reached
    await session.tick();
    expect(store.saves).toHaveLength(1);
    expect(store.lastSave.grades[0]!.facultyEdited?.totalPoints).toBe('7/10');
  });

  it('status transitions flush IMMEDIATELY and stamp startedAt/finishedAt', async () => {
    const { store, session, doc } = makeSession();
    await session.transition('RUNNING');
    expect(store.saves).toHaveLength(1);
    expect(doc.startedAt).not.toBeNull();
    expect(store.lastSave.status).toBe('RUNNING');

    await session.transition('CANCELLED');
    expect(store.saves).toHaveLength(2);
    expect(doc.finishedAt).not.toBeNull();
  });

  it('a failed checkpoint stays dirty and retries on its own (no new mutation needed)', async () => {
    const { clock, store, session } = makeSession();
    session.updateGrade(1, (g) => {
      g.status = 'EXTRACTING';
    });
    store.failNextSave = true;

    clock.advance(PROGRESS_FLUSH_INTERVAL_MS);
    await session.tick(); // fails silently (warn sink)
    expect(store.saves).toHaveLength(0);
    // A failed save must NEVER look clean.
    expect(session.hasPendingChanges).toBe(true);

    // The retry is scheduled with a short backoff — no further mutation needed.
    clock.advance(1_000);
    await session.tick();
    expect(store.saves).toHaveLength(1);
    expect(store.lastSave.grades[0]!.status).toBe('EXTRACTING');
    expect(session.hasPendingChanges).toBe(false);
  });

  it('dispose() still writes a checkpoint whose last save failed (a POSTED marker is never lost)', async () => {
    const { store, session } = makeSession();
    session.updateGrade(1, (g) => {
      g.status = 'POSTED';
      g.postedAt = '2026-06-10T16:00:00.000Z';
    });
    store.failNextSave = true;
    await expect(session.flush()).rejects.toThrow();
    expect(store.saves).toHaveLength(0);

    await session.dispose();
    expect(store.saves).toHaveLength(1);
    expect(store.lastSave.grades[0]!.postedAt).toBe('2026-06-10T16:00:00.000Z');
  });

  it('backs off between retries of a failing checkpoint', async () => {
    const { clock, store, session } = makeSession();
    session.updateGrade(1, (g) => {
      g.status = 'EXTRACTING';
    });
    store.failAlways = true;
    clock.advance(PROGRESS_FLUSH_INTERVAL_MS);
    await session.tick(); // attempt 1 fails → retry in 1s
    clock.advance(1_000);
    await session.tick(); // attempt 2 fails → retry in 2s
    const attemptsAfterTwo = store.attempts;
    clock.advance(1_000);
    await session.tick(); // not yet due (2s backoff)
    expect(store.attempts).toBe(attemptsAfterTwo);
    clock.advance(1_000);
    await session.tick(); // due
    expect(store.attempts).toBe(attemptsAfterTwo + 1);
    store.failAlways = false;
  });
});

describe('RunSession edit lock + heartbeat', () => {
  it('rejects edits on APPROVED / POSTED / in-flight rows (RowLockedError)', () => {
    const { session } = makeSession();
    const draft = { totalPoints: '7/10', assignmentFeedback: 'x', rubrics: [] };
    for (const status of ['APPROVED', 'POSTED', 'SCORING', 'ERROR'] as const) {
      session.updateGrade(1, (g) => {
        g.status = status;
      });
      expect(() => session.saveFacultyEdit(1, draft)).toThrow(RowLockedError);
    }
    session.updateGrade(1, (g) => {
      g.status = 'DRAFT';
    });
    session.saveFacultyEdit(1, draft, 'codex-chat');
    const row = session.document.grades[0]!;
    expect(row.status).toBe('EDITED');
    expect(row.editSource).toBe('codex-chat');
  });

  it('writes a heartbeat-only checkpoint while the run is open', async () => {
    const clock = new TestClock();
    const store = new FakeRunStore();
    const doc = makeRunDoc({ status: 'REVIEWING' });
    const session = new RunSession({
      document: doc,
      store,
      ownerId: 'rev-1:abc',
      now: clock.now,
      startLoop: false,
      heartbeatMs: HEARTBEAT_FLUSH_MS,
    });
    await session.flush();
    expect(store.saves).toHaveLength(1);

    clock.advance(HEARTBEAT_FLUSH_MS - 1);
    await session.tick();
    expect(store.saves).toHaveLength(1); // nothing changed, not yet due

    clock.advance(1);
    await session.tick();
    expect(store.saves).toHaveLength(2); // heartbeat-only flush
    expect(store.lastSave.lock?.heartbeatUtc).toBe(clock.now().toISOString());

    // Terminal runs stop heartbeating.
    await session.transition('COMPLETED');
    const count = store.saves.length;
    clock.advance(HEARTBEAT_FLUSH_MS * 2);
    await session.tick();
    expect(store.saves).toHaveLength(count);
  });
});

describe('RunSession RunLock + counters', () => {
  it('every flush refreshes the advisory RunLock (owner, ownerName, heartbeat)', async () => {
    const { clock, store, session } = makeSession();
    await session.flush();
    const first = store.lastSave.lock!;
    expect(first.owner).toBe('rev-1:abc');
    expect(first.ownerName).toBe('John Doe');
    expect(first.heartbeatUtc).toBe(clock.now().toISOString());

    clock.advance(60_000);
    await session.flush();
    const second = store.lastSave.lock!;
    expect(Date.parse(second.heartbeatUtc)).toBeGreaterThan(Date.parse(first.heartbeatUtc));
  });

  it('recomputes total/completed/error counters on every mutation', () => {
    const { session, doc } = makeSession(3);
    session.updateGrade(1, (g) => {
      g.status = 'DRAFT';
    });
    session.updateGrade(2, (g) => {
      g.status = 'ERROR';
    });
    expect(doc.totalCount).toBe(3);
    expect(doc.completedCount).toBe(1); // DRAFT and beyond
    expect(doc.errorCount).toBe(1);
  });

  it('quiz runs count quizGrades (not grades)', () => {
    const clock = new TestClock();
    const store = new FakeRunStore();
    const doc = makeRunDoc({
      canvasQuizId: 42,
      quizGrades: [
        {
          canvasUserId: 1,
          studentName: 'S1',
          quizSubmissionId: 100,
          attempt: 1,
          questionId: 7,
          questionName: 'Q7',
          maxPoints: 5,
          status: 'PENDING',
          answerExcerpt: null,
          aiDraft: null,
          facultyEdited: null,
          errorMessage: null,
          postedAt: null,
          updatedAt: '2026-06-10T15:00:00.000Z',
        },
      ],
    });
    const session = new RunSession({ document: doc, store, now: clock.now, startLoop: false });
    session.updateQuizGrade(100, 7, (g) => {
      g.status = 'DRAFT';
    });
    expect(doc.totalCount).toBe(1);
    expect(doc.completedCount).toBe(1);
  });

  it('change subscribers fire on mutations and cannot break the pipeline', () => {
    const { session } = makeSession();
    let events = 0;
    session.onChange(() => {
      events++;
      throw new Error('subscriber blew up');
    });
    session.updateGrade(1, (g) => {
      g.status = 'EXTRACTING';
    }); // must not throw
    expect(events).toBe(1);
  });
});

describe('RunSession dispose', () => {
  it('dispose writes a final checkpoint when changes are pending', async () => {
    const { store, session } = makeSession();
    session.updateGrade(1, (g) => {
      g.status = 'DRAFT';
    });
    await session.dispose();
    expect(store.saves).toHaveLength(1);
    expect(store.lastSave.grades[0]!.status).toBe('DRAFT');
  });

  it('dispose without pending changes writes nothing', async () => {
    const { store, session } = makeSession();
    await session.dispose();
    expect(store.saves).toHaveLength(0);
  });
});

describe('edit deadline honors the earliest edit', () => {
  it(`keeps the first deadline when edits stack (${EDIT_FLUSH_DELAY_MS}ms tier)`, async () => {
    const { clock, store, session } = makeSession();
    session.updateGrade(1, (g) => {
      g.status = 'DRAFT';
    });
    await session.flush();
    store.saves.length = 0;

    session.saveFacultyEdit(1, { totalPoints: '1/10', assignmentFeedback: 'a', rubrics: [] });
    clock.advance(2000);
    session.saveFacultyEdit(1, { totalPoints: '2/10', assignmentFeedback: 'b', rubrics: [] });
    clock.advance(1000); // first deadline (3s) hits — second edit rides along
    await session.tick();
    expect(store.saves).toHaveLength(1);
    expect(store.lastSave.grades[0]!.facultyEdited?.totalPoints).toBe('2/10');
  });
});
