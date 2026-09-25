// Grading-run document persistence: one JSON file per run in the hidden
// "runs/" Canvas subfolder — the durable checkpoint that makes
// close-browser-and-resume work with no database.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\RunStore.cs
// (filename build/parse pinned by tests\AiGrader.Tests\RunStoreTests.cs).
//
// NOTE: RunSession (the in-memory live session — debounce flush loops,
// change subscriptions, RunLock heartbeating) is deliberately NOT ported
// here; it lives in packages/engine. This layer is only the
// document persistence: filenames, listing, load/save, retention sweep, and
// course-copy orphan detection.
//
// CONSISTENCY MODEL: the Canvas file is a CHECKPOINT, not a coordination
// medium; last-write-wins is accepted and the advisory RunLock (engine-side)
// covers the residual case (a second laptop or co-instructor opening a run).

import { GradingRunDocumentSchema } from '@aigrader/shared';
import type { GradingRunDocument } from '@aigrader/shared';
import type { CourseDocumentStore } from './course-doc-store.js';

/** Subfolder (under the course storage root) holding run documents. */
export const RUNS_SUBFOLDER = 'runs';

/** Terminal runs older than this are swept (C# RetentionAge = 30 days). */
export const RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Newest runs kept per assignment by the sweep (C# MaxRunsPerAssignment). */
export const MAX_RUNS_PER_ASSIGNMENT = 10;

/** A run discovered by listing the runs folder (no document download needed). */
export type RunListEntry = {
  /** Full run id (from the filename). */
  runId: string;
  /** The assignment graded (from the filename). */
  canvasAssignmentId: number;
  /** Run creation time (from the filename), as an ISO UTC string. */
  createdAt: string;
  /** The stored filename. */
  filename: string;
};

/**
 * The UTC stamp segment of a run filename, exactly as the C# app emits it:
 * `doc.CreatedAt.UtcDateTime:yyyyMMddTHHmmssZ` — e.g. "20260610T160211Z"
 * (seconds precision, no separators, trailing literal Z, always UTC).
 */
export function runStamp(createdAt: string | Date): string {
  const date = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid run createdAt: '${String(createdAt)}'.`);
  }
  const iso = date.toISOString(); // normalizes any offset to UTC (C# .UtcDateTime)
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(
    14,
    16,
  )}${iso.slice(17, 19)}Z`;
}

/**
 * Filename for a run document:
 * `run-a{assignmentId}-{yyyyMMddTHHmmssZ}-{runId}.json`.
 * The format is LOAD-BEARING (a C# compatibility contract): listRuns parses it,
 * and both predecessor apps' files must keep parsing.
 */
export function runFilename(
  doc: Pick<GradingRunDocument, 'runId' | 'canvasAssignmentId' | 'createdAt'>,
): string {
  return `run-a${doc.canvasAssignmentId}-${runStamp(doc.createdAt)}-${doc.runId}.json`;
}

const STAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** Parses a run filename back into a list entry; null for foreign files. */
export function parseRunFilename(filename: string): RunListEntry | null {
  // run-a{assignmentId}-{yyyyMMddTHHmmssZ}-{runId}.json
  if (!filename.startsWith('run-a') || !filename.endsWith('.json')) return null;
  const core = filename.slice('run-a'.length, -'.json'.length);

  // C# used Split('-', 3): at most three parts, dashes in the runId survive.
  const first = core.indexOf('-');
  if (first < 0) return null;
  const second = core.indexOf('-', first + 1);
  if (second < 0) return null;

  const assignmentPart = core.slice(0, first);
  const stampPart = core.slice(first + 1, second);
  const runId = core.slice(second + 1);

  if (!/^\d+$/.test(assignmentPart)) return null;

  const match = STAMP_PATTERN.exec(stampPart);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const createdAt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Reject calendar rollovers (month 13 → next year, etc.) the way the C#
  // TryParseExact would.
  if (
    createdAt.getUTCFullYear() !== y ||
    createdAt.getUTCMonth() !== mo - 1 ||
    createdAt.getUTCDate() !== d ||
    createdAt.getUTCHours() !== h ||
    createdAt.getUTCMinutes() !== mi ||
    createdAt.getUTCSeconds() !== s
  ) {
    return null;
  }

  return {
    runId,
    canvasAssignmentId: Number(assignmentPart),
    createdAt: createdAt.toISOString(),
    filename,
  };
}

export type RunStoreOptions = {
  store: CourseDocumentStore;
  /** Injectable clock for the retention sweep (tests). */
  now?: () => Date;
  /** Warning sink (default console.warn). */
  warn?: (message: string) => void;
};

/** Lists, saves, loads, deletes, and sweeps grading-run documents. */
export class RunStore {
  private readonly store: CourseDocumentStore;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  constructor(options: RunStoreOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * Lists the course's runs from the folder listing alone — the filename
   * encodes run id, assignment, and creation time, so the dashboard can show
   * recent runs (newest first) without downloading any documents.
   */
  async listRuns(courseId: number, apiDomain?: string | null): Promise<RunListEntry[]> {
    const files = await this.store.list(courseId, RUNS_SUBFOLDER, apiDomain);
    return files
      .map((f) => parseRunFilename(f.filename))
      .filter((e): e is RunListEntry => e !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Persists a run document at its canonical filename (the seed checkpoint
   * that makes a new run discoverable, and every later flush). The document's
   * own canvasApiDomain decides which instance it checkpoints to — the run
   * carries its own routing so flushes survive restarts (C# CreateRunAsync /
   * RunSession.FlushAsync). Returns the relative path written.
   */
  async saveRun(doc: GradingRunDocument): Promise<string> {
    const relativePath = `${RUNS_SUBFOLDER}/${runFilename(doc)}`;
    await this.store.put(doc.canvasCourseId, relativePath, doc, doc.canvasApiDomain);
    return relativePath;
  }

  /**
   * Loads a run document by id. Null when the run does not exist or belongs
   * to a different course (course-copy orphan — one course's student data
   * must never surface in another; cleanup will delete it).
   */
  async loadRun(
    courseId: number,
    runId: string,
    apiDomain?: string | null,
  ): Promise<GradingRunDocument | null> {
    const entry = (await this.listRuns(courseId, apiDomain)).find((e) => e.runId === runId);
    if (!entry) return null;

    // Always a FRESH read: run checkpoints are the one document several
    // computers write (a co-instructor, a second laptop), and a resume or
    // lock check must never act on a cached copy.
    const doc = await this.store.get(
      courseId,
      `${RUNS_SUBFOLDER}/${entry.filename}`,
      GradingRunDocumentSchema,
      apiDomain,
      { fresh: true },
    );
    if (doc === null) return null;

    // Course fingerprint: a mismatch means this file rode in on a course
    // copy. Refuse to open (cleanup will delete it).
    if (doc.canvasCourseId !== courseId) {
      this.warn(
        `[run-store] Run ${runId} is a course-copy orphan ` +
          `(doc course ${doc.canvasCourseId}, launched course ${courseId})`,
      );
      return null;
    }

    // The checkpoint was just FOUND on the launch instance, so that instance
    // is authoritative — rebind the document to it (covers docs written
    // before canvasApiDomain existed, which carry null).
    doc.canvasApiDomain = this.store.resolveDomain(apiDomain);
    return doc;
  }

  /** Deletes a run's document. */
  async deleteRun(courseId: number, runId: string, apiDomain?: string | null): Promise<void> {
    const entry = (await this.listRuns(courseId, apiDomain)).find((e) => e.runId === runId);
    if (entry) {
      await this.store.delete(courseId, `${RUNS_SUBFOLDER}/${entry.filename}`, apiDomain);
    }
  }

  /**
   * Retention + copy-orphan sweep, fired in the background (throttled) when a
   * course's runs are listed. Candidates are runs older than 30 days
   * (filename date) and runs beyond the newest 10 per assignment; a
   * candidate is deleted only when it is FINISHED (COMPLETED/CANCELLED) or
   * ABANDONED (no update for 30 days) — a run still being reviewed or posted
   * is never swept out from under the teacher. Documents whose embedded
   * course id doesn't match (a Canvas course copy carried them in — student
   * data that must not surface in the new course) are always deleted.
   * Best-effort housekeeping — never throws.
   */
  async cleanup(courseId: number, apiDomain?: string | null): Promise<void> {
    try {
      const files = await this.store.list(courseId, RUNS_SUBFOLDER, apiDomain);
      const entries = files
        .map((f) => parseRunFilename(f.filename))
        .filter((e): e is RunListEntry => e !== null);

      const candidates = new Set<string>();
      const nowMs = this.now().getTime();

      // Age-based retention (filename date).
      for (const entry of entries) {
        if (nowMs - Date.parse(entry.createdAt) > RETENTION_AGE_MS) {
          candidates.add(entry.filename);
        }
      }

      // Per-assignment cap: beyond the newest MAX_RUNS_PER_ASSIGNMENT.
      const byAssignment = new Map<number, RunListEntry[]>();
      for (const entry of entries) {
        const group = byAssignment.get(entry.canvasAssignmentId) ?? [];
        group.push(entry);
        byAssignment.set(entry.canvasAssignmentId, group);
      }
      for (const group of byAssignment.values()) {
        const overflow = group
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(MAX_RUNS_PER_ASSIGNMENT);
        for (const entry of overflow) candidates.add(entry.filename);
      }

      const deletions: string[] = [];
      for (const entry of entries) {
        const doc = await this.store.get(
          courseId,
          `${RUNS_SUBFOLDER}/${entry.filename}`,
          GradingRunDocumentSchema,
          apiDomain,
        );
        if (doc === null) {
          // Unreadable: keep a young one (never guess), let an old one age out.
          if (candidates.has(entry.filename)) deletions.push(entry.filename);
          continue;
        }
        if (doc.canvasCourseId !== courseId) {
          deletions.push(entry.filename); // course-copy orphan
          continue;
        }
        if (!candidates.has(entry.filename)) continue;
        const finished = doc.status === 'COMPLETED' || doc.status === 'CANCELLED';
        const lastTouchMs = Date.parse(doc.updatedAt);
        const abandoned = !Number.isFinite(lastTouchMs) || nowMs - lastTouchMs > RETENTION_AGE_MS;
        if (finished || abandoned) deletions.push(entry.filename);
      }

      for (const filename of deletions) {
        await this.store.delete(courseId, `${RUNS_SUBFOLDER}/${filename}`, apiDomain);
      }
    } catch (err) {
      // Cleanup is best-effort housekeeping — never let it break a launch.
      this.warn(
        `[run-store] Run cleanup failed for course ${courseId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
