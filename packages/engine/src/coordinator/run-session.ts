// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\RunSession.cs
//
// The live, in-memory state of one grading run — the single object every
// consumer shares: the engine mutates it, snapshot routes read it, and the
// checkpoint loop persists it to Canvas (via RunStore.saveRun).
//
// CHECKPOINT POLICY: grade
// progress debounces at 15s / 25 dirty items (drafts are cheap to
// regenerate); faculty edits flush within ~3s (human work is the expensive
// thing to lose); status transitions and postings flush IMMEDIATELY (they
// gate idempotency). Every flush refreshes the advisory RunLock
// {owner, ownerName, heartbeatUtc}; while the run is open a heartbeat-only
// flush keeps that lock fresh even when nothing changed, so a second laptop
// can tell the run is live here.
//
// A FAILED checkpoint never looks clean: its dirty state is restored and the
// next tick retries (with backoff), and dispose() still writes it.
//
// PORT DELTAS (deliberate):
//   - No mutation locking: Node is single-threaded; the C# lock(_sync)
//     ceremony has no equivalent hazard here.
//   - The 1s PeriodicTimer loop becomes an injectable setInterval so tests
//     drive the debounce tiers with fake timers.
//   - The instance id is `${hostname}:{uuid}` — the C# "MACHINENAME:guid"
//     form, so a co-instructor's laptop is identifiable in the RunLock.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  EditSource,
  GradeStatus,
  GraderDraft,
  GradingRunDocument,
  QuizDraft,
  QuizQuestionGradeEntry,
  RunLock,
  RunStatus,
  StudentGrade,
} from '@aigrader/shared';

/** Grade-progress debounce window (C# ProgressFlushInterval). */
export const PROGRESS_FLUSH_INTERVAL_MS = 15_000;
/** Faculty-edit flush deadline (C# EditFlushDelay). */
export const EDIT_FLUSH_DELAY_MS = 3_000;
/** Dirty-item count that forces a flush (C# ProgressFlushDirtyCount). */
export const PROGRESS_FLUSH_DIRTY_COUNT = 25;
/** The debounce loop's tick (C# PeriodicTimer(1s)). */
export const FLUSH_TICK_MS = 1_000;
/** Heartbeat-only flush cadence while a run is open (keeps the RunLock
 * fresh; the staleness threshold is 150s). */
export const HEARTBEAT_FLUSH_MS = 60_000;
/** Longest backoff between retries of a failing checkpoint. */
export const MAX_FLUSH_RETRY_MS = 30_000;

/** Rows a faculty edit may touch: drafts only. APPROVED/POSTED rows are
 * locked (what posts is what was approved); in-flight and ERROR rows have
 * no draft to edit. */
export const EDITABLE_STATUSES: readonly GradeStatus[] = ['DRAFT', 'EDITED'];

/** Thrown when an edit targets a row that is not editable. */
export class RowLockedError extends Error {
  constructor(readonly status: GradeStatus) {
    super(
      status === 'APPROVED' || status === 'POSTED'
        ? 'This grade is already approved — it can no longer be edited.'
        : `This row has no draft to edit (status ${status}).`,
    );
    this.name = 'RowLockedError';
  }
}

/** Identifies this local server process for the advisory run lock
 * ("{hostname}:{instanceGuid}" — the C# "MACHINENAME:guid" form). */
export const INSTANCE_ID = `${hostname()}:${randomUUID()}`;

/** "Reached DRAFT or beyond" — the completed-counter statuses. */
const COMPLETED_STATUSES: readonly GradeStatus[] = ['DRAFT', 'EDITED', 'APPROVED', 'POSTED'];
/** Terminal run statuses (FinishedAt is stamped on entry). */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** The slice of RunStore this session persists through (structural so tests
 * drive it with an in-memory fake; the real RunStore satisfies it as-is). */
export interface RunSaverPort {
  saveRun(doc: GradingRunDocument): Promise<string>;
}

export interface RunSessionOptions {
  /** The seed or rehydrated run document (the session owns it from here). */
  document: GradingRunDocument;
  /** Where checkpoints go (RunStore or a fake). */
  store: RunSaverPort;
  /** Advisory-lock owner id; defaults to this process's INSTANCE_ID. */
  ownerId?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Warning sink for failed checkpoints (default console.warn). */
  warn?: (message: string) => void;
  /** When false, the 1s debounce loop is not started (tests drive tick()). */
  startLoop?: boolean;
  /** Heartbeat-only flush cadence (ms) while the run is non-terminal;
   * 0/undefined disables it (tests). The engine passes HEARTBEAT_FLUSH_MS. */
  heartbeatMs?: number;
  /**
   * Reads the lock currently in Canvas (fresh). Consulted before a flush
   * that follows a long silence (laptop asleep, network down): if another
   * computer took the run over meanwhile, this session must not overwrite
   * that computer's checkpoint.
   */
  peekLock?: () => Promise<RunLock | null | undefined>;
  /** A silence longer than this triggers the peek (the lock-stale window). */
  staleGapMs?: number;
  /** Called once when another computer is found to own the run. */
  onEvicted?: (lock: RunLock) => void;
}

/** Live state + checkpointing for one grading run. */
export class RunSession {
  readonly document: GradingRunDocument;

  private readonly store: RunSaverPort;
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly heartbeatMs: number;
  private readonly peekLock?: RunSessionOptions['peekLock'];
  private readonly staleGapMs: number;
  private readonly onEvicted?: RunSessionOptions['onEvicted'];
  /** Last SUCCESSFUL checkpoint (ms). */
  private lastSavedMs = Number.NEGATIVE_INFINITY;
  private evicted = false;

  private dirtyCount = 0;
  private consecutiveFailures = 0;
  private lastFlushMs = Number.NEGATIVE_INFINITY;
  private flushDeadlineMs: number | null = null;
  private disposed = false;
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly changeListeners = new Set<() => void>();

  constructor(options: RunSessionOptions) {
    this.document = options.document;
    this.store = options.store;
    this.ownerId = options.ownerId ?? INSTANCE_ID;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.heartbeatMs = options.heartbeatMs ?? 0;
    this.peekLock = options.peekLock;
    this.staleGapMs = options.staleGapMs ?? 150_000;
    this.onEvicted = options.onEvicted;
    if (options.startLoop !== false) {
      this.timer = setInterval(() => {
        void this.tick();
      }, FLUSH_TICK_MS);
      // Never keep the process alive just for a debounce loop.
      this.timer.unref?.();
    }
  }

  /** Set by dispose({releaseLock}) — the final write clears the lock. */
  private releasingLock = false;

  /** True once another computer was found owning the run (no more writes). */
  get isEvicted(): boolean {
    return this.evicted;
  }
  /** Advisory-lock owner id this session writes into every checkpoint. */
  get owner(): string {
    return this.ownerId;
  }

  /**
   * Subscribes to the change signal. A WAKE-UP only — subscribers re-read
   * `document`; the event carries no data, so a missed event can never mean
   * missed data. Returns the unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  // ------------------------------------------------------------ mutations --

  /** Transitions the run status. Flushes immediately — status gates resume
   * behavior (and, on POSTING/terminal, idempotency). */
  async transition(status: RunStatus): Promise<void> {
    const nowIso = this.now().toISOString();
    this.document.status = status;
    if (status === 'RUNNING' && this.document.startedAt == null) {
      this.document.startedAt = nowIso;
    }
    if (TERMINAL_RUN_STATUSES.includes(status)) {
      this.document.finishedAt = nowIso;
    }
    this.raiseChanged();
    await this.flush();
  }

  /**
   * Updates one student's grade row via `mutate` and recomputes run counters.
   * Debounced flush (grade-progress tier).
   */
  updateGrade(canvasUserId: number, mutate: (grade: StudentGrade) => void): void {
    const grade = this.document.grades.find((g) => g.canvasUserId === canvasUserId);
    if (!grade) {
      throw new Error(`Run ${this.document.runId} has no grade row for user ${canvasUserId}.`);
    }
    mutate(grade);
    grade.updatedAt = this.now().toISOString();
    this.recomputeCounters();
    this.dirtyCount++;
    this.raiseChanged();
  }

  /** Updates one quiz-question grade row (quiz runs). Debounced flush. */
  updateQuizGrade(
    quizSubmissionId: number,
    questionId: number,
    mutate: (entry: QuizQuestionGradeEntry) => void,
  ): void {
    const grade = this.document.quizGrades.find(
      (g) => g.quizSubmissionId === quizSubmissionId && g.questionId === questionId,
    );
    if (!grade) {
      throw new Error(
        `Run ${this.document.runId} has no quiz grade row for submission ${quizSubmissionId} question ${questionId}.`,
      );
    }
    mutate(grade);
    grade.updatedAt = this.now().toISOString();
    this.recomputeCounters();
    this.dirtyCount++;
    this.raiseChanged();
  }

  /**
   * Records a faculty edit (the expensive-to-lose tier): flushes within ~3
   * seconds rather than the 15-second progress debounce.
   */
  saveFacultyEdit(
    canvasUserId: number,
    edited: GraderDraft,
    source: EditSource = 'browser',
  ): void {
    const row = this.document.grades.find((g) => g.canvasUserId === canvasUserId);
    if (row && !EDITABLE_STATUSES.includes(row.status)) throw new RowLockedError(row.status);
    this.updateGrade(canvasUserId, (g) => {
      g.facultyEdited = edited;
      g.editSource = source;
      g.staleEdit = undefined;
      if (g.status === 'DRAFT') g.status = 'EDITED';
    });
    this.armEditDeadline();
  }

  /** Quiz counterpart of saveFacultyEdit (same ~3s flush tier). */
  saveQuizFacultyEdit(
    quizSubmissionId: number,
    questionId: number,
    edited: QuizDraft,
    source: EditSource = 'browser',
  ): void {
    const row = this.document.quizGrades.find(
      (g) => g.quizSubmissionId === quizSubmissionId && g.questionId === questionId,
    );
    if (row && !EDITABLE_STATUSES.includes(row.status)) throw new RowLockedError(row.status);
    this.updateQuizGrade(quizSubmissionId, questionId, (g) => {
      g.facultyEdited = edited;
      g.editSource = source;
      g.staleEdit = undefined;
      if (g.status === 'DRAFT') g.status = 'EDITED';
    });
    this.armEditDeadline();
  }

  /** Replaces the grade list during fan-out (copy-on-write — the list is
   * replaced, never mutated in place, so concurrent readers stay safe). */
  setGrades(grades: StudentGrade[]): void {
    this.document.grades = grades;
    this.recomputeCounters();
    this.raiseChanged();
  }

  /** Replaces the quiz grade list during quiz fan-out (copy-on-write). */
  setQuizGrades(grades: QuizQuestionGradeEntry[]): void {
    this.document.quizGrades = grades;
    this.recomputeCounters();
    this.raiseChanged();
  }

  private armEditDeadline(): void {
    const deadline = this.now().getTime() + EDIT_FLUSH_DELAY_MS;
    if (this.flushDeadlineMs === null || deadline < this.flushDeadlineMs) {
      this.flushDeadlineMs = deadline;
    }
  }

  private recomputeCounters(): void {
    const doc = this.document;
    if (doc.canvasQuizId != null) {
      doc.totalCount = doc.quizGrades.length;
      doc.completedCount = doc.quizGrades.filter((g) =>
        COMPLETED_STATUSES.includes(g.status),
      ).length;
      doc.errorCount = doc.quizGrades.filter((g) => g.status === 'ERROR').length;
    } else {
      doc.totalCount = doc.grades.length;
      doc.completedCount = doc.grades.filter((g) => COMPLETED_STATUSES.includes(g.status)).length;
      doc.errorCount = doc.grades.filter((g) => g.status === 'ERROR').length;
    }
  }

  private raiseChanged(): void {
    for (const listener of this.changeListeners) {
      // Subscriber exceptions must never break the engine's mutation path.
      try {
        listener();
      } catch (err) {
        this.warn(
          `[run-session] Run ${this.document.runId} change subscriber threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ----------------------------------------------------------- checkpoint --

  private evict(lock: RunLock): void {
    if (this.evicted) return;
    this.evicted = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.warn(
      `[run-session] Run ${this.document.runId} was opened on another computer${
        lock.ownerName ? ` (${lock.ownerName})` : ''
      } while this one was away; this computer stopped working on it.`,
    );
    this.onEvicted?.(lock);
  }

  /** Serializes and uploads the checkpoint now, refreshing the advisory lock.
   * Concurrent callers coalesce onto one in-flight save. */
  async flush(): Promise<void> {
    // Coalesce: a flush that starts while another is in flight waits for it,
    // then re-checks — the second write captures every mutation the first
    // missed. (The C# app relied on lock(_sync) + PutFileAsync ordering.)
    while (this.flushing) {
      await this.flushing;
    }
    const work = this.doFlush();
    this.flushing = work.finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.evicted) return;
    if (
      this.peekLock &&
      Number.isFinite(this.lastSavedMs) &&
      this.now().getTime() - this.lastSavedMs > this.staleGapMs
    ) {
      // Long silence: did another computer take the run over meanwhile?
      let lock: RunLock | null | undefined;
      try {
        lock = await this.peekLock();
      } catch {
        lock = undefined; // can't tell — proceed; the next flush asks again
      }
      const heartbeatMs = lock ? Date.parse(lock.heartbeatUtc) : Number.NaN;
      if (
        lock &&
        lock.owner &&
        lock.owner !== this.ownerId &&
        Number.isFinite(heartbeatMs) &&
        heartbeatMs > this.lastSavedMs
      ) {
        this.evict(lock);
        return;
      }
    }
    const nowIso = this.now().toISOString();
    this.document.updatedAt = nowIso;
    this.document.lock = this.releasingLock
      ? null
      : {
          owner: this.ownerId,
          ownerName: this.document.facultyName,
          heartbeatUtc: nowIso,
        };
    const pendingDirty = this.dirtyCount;
    this.dirtyCount = 0;
    this.flushDeadlineMs = null;
    this.lastFlushMs = this.now().getTime();

    try {
      // The checkpoint goes to the instance the run belongs to — the document
      // carries its own canvasApiDomain routing (RunStore.saveRun honors it).
      await this.store.saveRun(this.document);
      this.consecutiveFailures = 0;
      this.lastSavedMs = this.now().getTime();
    } catch (err) {
      // Never let a failed save look clean: restore what was pending (plus
      // anything that changed during the await) and schedule a retry with
      // backoff — the next tick picks it up, and dispose() still writes it.
      this.consecutiveFailures += 1;
      this.dirtyCount = Math.max(this.dirtyCount + pendingDirty, 1);
      const retryAt =
        this.now().getTime() +
        Math.min(MAX_FLUSH_RETRY_MS, 1_000 * 2 ** (this.consecutiveFailures - 1));
      // (The deadline that triggered this flush is consumed; only a deadline
      // armed DURING the await may pull the retry earlier.)
      this.flushDeadlineMs = Math.min(this.flushDeadlineMs ?? retryAt, retryAt);
      throw err;
    }
  }

  /**
   * One debounce-loop iteration: flushes when the progress tier (15s / 25
   * items) or an edit deadline (~3s) is due. Public so tests (and the
   * interval started in the constructor) drive it explicitly.
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const nowMs = this.now().getTime();
    const heartbeatDue =
      this.heartbeatMs > 0 &&
      !TERMINAL_RUN_STATUSES.includes(this.document.status) &&
      nowMs - this.lastFlushMs >= this.heartbeatMs;
    const due =
      (this.dirtyCount > 0 && nowMs - this.lastFlushMs >= PROGRESS_FLUSH_INTERVAL_MS) ||
      this.dirtyCount >= PROGRESS_FLUSH_DIRTY_COUNT ||
      (this.flushDeadlineMs !== null && nowMs >= this.flushDeadlineMs) ||
      heartbeatDue;
    if (!due) return;

    try {
      await this.flush();
    } catch (err) {
      // A failed checkpoint is survivable (the next tick retries); in-memory
      // state remains the authority while the server is up.
      this.warn(
        `[run-session] Run ${this.document.runId} checkpoint failed; will retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** True when unsaved mutations (or an armed edit deadline) exist. */
  get hasPendingChanges(): boolean {
    return this.dirtyCount > 0 || this.flushDeadlineMs !== null;
  }

  /** Stops the debounce loop and writes a final best-effort checkpoint. */
  /**
   * Stops the flush loop and writes the final checkpoint. `releaseLock`
   * (shutdown) clears the advisory lock in that write, so another computer
   * can open the run right away instead of waiting out the stale window.
   */
  async dispose(opts: { releaseLock?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.evicted) return; // another computer owns the checkpoint now
    try {
      if (opts.releaseLock) {
        this.releasingLock = true;
        await this.flush();
      } else if (this.hasPendingChanges) {
        await this.flush();
      }
    } catch (err) {
      this.warn(
        `[run-session] Run ${this.document.runId} final checkpoint failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
