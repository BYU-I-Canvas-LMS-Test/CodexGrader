// Local run-progress records — the engine's in-memory mirror of each run's
// counts/status/heartbeat, and the review page's polling surface (the web
// tier asks the in-process engine; there is no database). COUNTS/STATUS/
// HEARTBEAT/IDS ONLY — never student content, never names.
//
// Write cadence: coalesced ≤1 per 2s while the session is changing, a
// forced 15s heartbeat while the run is live (the resume sweep's staleness
// signal), and IMMEDIATE writes on status transitions and cancel
// acknowledgement.
//
// LocalProgressStore keeps every record in memory and hands the NON-TERMINAL
// ones to a `persist` callback whenever that set (or a status/cancel flag)
// changes; the local server writes them to ~/.aigrader/state/active-runs.json
// so interrupted runs resume automatically after a restart. Heartbeat-only
// updates never touch disk.

import type {
  GradeStatus,
  GradingRunDocument,
  RunProgressCounts,
  RunProgressDoc,
} from '@aigrader/shared';
import { TERMINAL_RUN_STATUSES } from '../coordinator/run-session.js';

/** Min gap between coalesced progress writes. */
export const PROGRESS_WRITE_MIN_INTERVAL_MS = 2_000;
/** Forced heartbeat interval while the run is live. */
export const PROGRESS_HEARTBEAT_INTERVAL_MS = 15_000;
/** A heartbeat older than this means the owner is gone (150s). */
export const RUN_LOCK_STALE_S = Number(process.env.RUN_LOCK_STALE_S ?? 150);

// ---------------------------------------------------------------- storage --

/** Storage seam: the writer/sweeper never touch persistence directly, so
 * tests drive them with an in-memory fake. */
export interface ProgressStorePort {
  /** Writes the record (a full snapshot). */
  set(runId: string, doc: RunProgressDoc): Promise<void>;
  get(runId: string): Promise<RunProgressDoc | null>;
  /** Every live (non-terminal) progress record. */
  listLive(): Promise<RunProgressDoc[]>;
  /** Flips the cancelRequested flag (used by routes without a full write). */
  requestCancel(runId: string): Promise<void>;
}

export interface LocalProgressStoreOptions {
  /** Records restored from ~/.aigrader/state/active-runs.json at startup. */
  initial?: readonly RunProgressDoc[];
  /** Receives the live (non-terminal) records whenever that set changes.
   * Failures are the callback's business (the server logs and retries). */
  persist?: (live: RunProgressDoc[]) => void | Promise<void>;
}

/** Live = non-terminal and not merely adopted (an adopted record describes a
 * run this process never started; it only becomes live here once resumed). */
function isLive(doc: RunProgressDoc): boolean {
  return !TERMINAL_RUN_STATUSES.includes(doc.status) && (doc as { adopted?: unknown }).adopted !== true;
}

/** Signature of the fields that matter on disk — heartbeats excluded. */
function persistKey(docs: Iterable<RunProgressDoc>): string {
  return JSON.stringify(
    [...docs]
      .filter(isLive)
      .map((d) => [d.runId, d.status, d.cancelRequested, d.courseKey, d.apiDomain])
      .sort(),
  );
}

/** In-memory progress records with change-driven persistence of live runs. */
export class LocalProgressStore implements ProgressStorePort {
  private readonly docs = new Map<string, RunProgressDoc>();
  private readonly persist?: LocalProgressStoreOptions['persist'];
  private lastPersisted: string;

  constructor(options: LocalProgressStoreOptions = {}) {
    for (const doc of options.initial ?? []) this.docs.set(doc.runId, doc);
    this.persist = options.persist;
    this.lastPersisted = persistKey(this.docs.values());
  }

  async set(runId: string, doc: RunProgressDoc): Promise<void> {
    this.docs.set(runId, doc);
    await this.maybePersist();
  }

  async get(runId: string): Promise<RunProgressDoc | null> {
    return this.docs.get(runId) ?? null;
  }

  async listLive(): Promise<RunProgressDoc[]> {
    return [...this.docs.values()].filter(isLive);
  }

  async requestCancel(runId: string): Promise<void> {
    const doc = this.docs.get(runId);
    if (!doc) return;
    this.docs.set(runId, { ...doc, cancelRequested: true, updatedAt: new Date().toISOString() });
    await this.maybePersist();
  }

  private async maybePersist(): Promise<void> {
    if (!this.persist) return;
    const key = persistKey(this.docs.values());
    if (key === this.lastPersisted) return;
    this.lastPersisted = key;
    await this.persist(await this.listLive());
  }
}

// ----------------------------------------------------------------- counts --

type CountKey =
  | 'pending'
  | 'extracting'
  | 'scoring'
  | 'drafted'
  | 'edited'
  | 'approved'
  | 'posted'
  | 'errors';

const STATUS_TO_COUNT_KEY: Record<GradeStatus, CountKey> = {
  PENDING: 'pending',
  EXTRACTING: 'extracting',
  SCORING: 'scoring',
  DRAFT: 'drafted',
  EDITED: 'edited',
  APPROVED: 'approved',
  POSTED: 'posted',
  ERROR: 'errors',
};

/** Per-status row counts derived from the run document (counts ONLY). */
export function deriveCounts(doc: GradingRunDocument): RunProgressCounts {
  const rows: Array<{ status: GradeStatus }> =
    doc.canvasQuizId != null ? doc.quizGrades : doc.grades;
  const tally: Record<CountKey, number> = {
    pending: 0,
    extracting: 0,
    scoring: 0,
    drafted: 0,
    edited: 0,
    approved: 0,
    posted: 0,
    errors: 0,
  };
  for (const row of rows) {
    tally[STATUS_TO_COUNT_KEY[row.status]] += 1;
  }
  return { total: rows.length, ...tally };
}

// ----------------------------------------------------------------- writer --

export interface ProgressWriterOptions {
  store: ProgressStorePort;
  /** The live run document counts/status are derived from. */
  document: GradingRunDocument;
  /** Static identity fields (IDs only). */
  runId: string;
  courseKey: string;
  apiDomain: string | null;
  /** Advisory-lock owner (the RunSession's owner id). */
  owner: string;
  resumeCount?: number;
  cancelRequested?: boolean;
  createdAt?: string;
  now?: () => Date;
  warn?: (message: string) => void;
  /** When false, the heartbeat interval is not started (tests drive tick()). */
  startLoop?: boolean;
}

/**
 * Coalesced progress-record writer for one live run. Wire `schedule()` to the
 * RunSession change signal; call `writeNow()` on status transitions and
 * cancel acknowledgement; `noteCheckpoint()` after each Canvas flush.
 */
export class ProgressWriter {
  private readonly store: ProgressStorePort;
  private readonly document: GradingRunDocument;
  private readonly runId: string;
  private readonly courseKey: string;
  private readonly apiDomain: string | null;
  private readonly owner: string;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly createdAt: string;

  private resumeCount: number;
  private cancelRequested: boolean;
  private lastCanvasSaveIso: string | null = null;
  private lastWriteMs = Number.NEGATIVE_INFINITY;
  private pending = false;
  private writing: Promise<void> | null = null;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProgressWriterOptions) {
    this.store = options.store;
    this.document = options.document;
    this.runId = options.runId;
    this.courseKey = options.courseKey;
    this.apiDomain = options.apiDomain;
    this.owner = options.owner;
    this.resumeCount = options.resumeCount ?? 0;
    this.cancelRequested = options.cancelRequested ?? false;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.createdAt = options.createdAt ?? this.now().toISOString();
    if (options.startLoop !== false) {
      this.timer = setInterval(() => {
        void this.tick();
      }, PROGRESS_WRITE_MIN_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /** Marks the doc dirty; the next tick within the 2s window writes it. */
  schedule(): void {
    this.pending = true;
  }

  /** Records a successful Canvas checkpoint (surfaces as checkpoint.lastSavedAt). */
  noteCheckpoint(): void {
    this.lastCanvasSaveIso = this.now().toISOString();
    this.pending = true;
  }

  /** Mirrors the cancel flag (an immediate write follows via writeNow). */
  setCancelRequested(value: boolean): void {
    this.cancelRequested = value;
  }

  get isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  /** Bumps the resume counter (crash-resume telemetry). */
  noteResumed(): void {
    this.resumeCount += 1;
    this.pending = true;
  }

  /** One coalescing-loop iteration: writes when dirty (≤1 per 2s by loop
   * cadence) or when the forced 15s heartbeat is due. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const nowMs = this.now().getTime();
    const heartbeatDue = nowMs - this.lastWriteMs >= PROGRESS_HEARTBEAT_INTERVAL_MS;
    if (!this.pending && !heartbeatDue) return;
    if (nowMs - this.lastWriteMs < PROGRESS_WRITE_MIN_INTERVAL_MS) return;
    await this.write();
  }

  /** Immediate write — status transitions, cancel acks, resume, terminal. */
  async writeNow(): Promise<void> {
    await this.write();
  }

  /** Final write + stop the loop (SIGTERM / run removal). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.write();
    } catch (err) {
      this.warn(
        `[progress] Final progress write failed for run ${this.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** The doc as it would be written right now (tests/inspection). */
  snapshot(): RunProgressDoc {
    const nowIso = this.now().toISOString();
    return {
      runId: this.runId,
      canvasCourseId: this.document.canvasCourseId,
      canvasAssignmentId: this.document.canvasAssignmentId,
      apiDomain: this.apiDomain,
      courseKey: this.courseKey,
      status: this.document.status,
      counts: deriveCounts(this.document),
      cancelRequested: this.cancelRequested,
      worker: {
        owner: this.owner,
        heartbeatAt: nowIso,
        resumeCount: this.resumeCount,
      },
      checkpoint: { lastSavedAt: this.lastCanvasSaveIso },
      createdAt: this.createdAt,
      updatedAt: nowIso,
    };
  }

  private async write(): Promise<void> {
    // Coalesce concurrent writers onto one in-flight set().
    while (this.writing) {
      await this.writing;
    }
    this.pending = false;
    this.lastWriteMs = this.now().getTime();
    const doc = this.snapshot();
    const work = this.store.set(this.runId, doc).catch((err: unknown) => {
      this.pending = true; // retry on the next tick
      this.warn(
        `[progress] Progress write failed for run ${this.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    this.writing = work.finally(() => {
      this.writing = null;
    });
    await this.writing;
  }
}
