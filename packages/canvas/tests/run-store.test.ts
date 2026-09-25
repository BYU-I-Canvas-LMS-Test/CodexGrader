// RunStore behavior: the LOAD-BEARING run filename format (build + parse,
// pinned against strings exactly as the C# app emits them), listing, save/
// load with course-fingerprint orphan refusal, and the retention sweep
// (30 days / 10 per assignment / copy-orphan deletion).
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\RunStore.cs
// and C:\Devs\AIGrader-C#\tests\AiGrader.Tests\RunStoreTests.cs (the filename
// cases; document-serialization and draft-mapper cases live with their own
// modules).

import { describe, expect, it } from 'vitest';
import { GradingRunDocumentSchema, serializeStorageDocument } from '@aigrader/shared';
import type { GradingRunDocument } from '@aigrader/shared';
import {
  CourseDocumentStore,
  ROOT_FOLDER_NAME,
} from '../src/stores/course-doc-store.js';
import {
  MAX_RUNS_PER_ASSIGNMENT,
  RunStore,
  parseRunFilename,
  runFilename,
  runStamp,
} from '../src/stores/run-store.js';
import { FakeFilesClient } from './stores-helpers.js';

const RUNS_PATH = `${ROOT_FOLDER_NAME}/runs`;

function makeRunStore(nowIso = '2026-07-27T12:00:00Z') {
  const files = new FakeFilesClient();
  const warnings: string[] = [];
  const now = () => new Date(nowIso);
  const store = new CourseDocumentStore({ files, now, warn: (m) => warnings.push(m) });
  const runs = new RunStore({ store, now, warn: (m) => warnings.push(m) });
  return { files, store, runs, warnings };
}

function runDoc(overrides: Partial<GradingRunDocument> = {}): GradingRunDocument {
  return GradingRunDocumentSchema.parse({
    runId: '3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5',
    canvasCourseId: 397054,
    canvasAssignmentId: 11824,
    createdAt: '2026-06-10T16:02:11+00:00',
    updatedAt: '2026-06-10T16:02:11+00:00',
    ...overrides,
  });
}

function seedRun(files: FakeFilesClient, courseId: number, doc: GradingRunDocument): string {
  const filename = runFilename(doc);
  files.seedFile(courseId, RUNS_PATH, filename, serializeStorageDocument(doc));
  return filename;
}

describe('run filename format (byte-parity contract)', () => {
  it('emits the EXACT C# format and round-trips through the parser', () => {
    // Mirrors RunStoreTests.RunFilenameRoundTrips byte for byte.
    const doc = runDoc();
    const filename = runFilename(doc);
    expect(filename).toBe('run-a11824-20260610T160211Z-3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5.json');

    const entry = parseRunFilename(filename);
    expect(entry).not.toBeNull();
    expect(entry!.runId).toBe(doc.runId);
    expect(entry!.canvasAssignmentId).toBe(11824);
    expect(entry!.createdAt).toBe('2026-06-10T16:02:11.000Z');
    expect(entry!.filename).toBe(filename);
  });

  it('parses filenames exactly as the C# writer emits them (hand-written compat strings)', () => {
    // Hand-computed from the C# format string
    // $"run-a{id}-{CreatedAt.UtcDateTime:yyyyMMddTHHmmssZ}-{RunId}.json":
    const cases: Array<[string, number, string, string]> = [
      [
        'run-a11824-20260610T160211Z-3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5.json',
        11824,
        '2026-06-10T16:02:11.000Z',
        '3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5',
      ],
      [
        'run-a5-20250101T000000Z-0123456789abcdef0123456789abcdef.json',
        5,
        '2025-01-01T00:00:00.000Z',
        '0123456789abcdef0123456789abcdef',
      ],
      [
        'run-a99310-20251231T235959Z-aabbccddeeff00112233445566778899.json',
        99310,
        '2025-12-31T23:59:59.000Z',
        'aabbccddeeff00112233445566778899',
      ],
    ];
    for (const [filename, assignmentId, createdAt, runId] of cases) {
      const entry = parseRunFilename(filename);
      expect(entry, filename).not.toBeNull();
      expect(entry!.canvasAssignmentId).toBe(assignmentId);
      expect(entry!.createdAt).toBe(createdAt);
      expect(entry!.runId).toBe(runId);
    }
  });

  it('normalizes offset timestamps to UTC in the stamp (C# .UtcDateTime parity)', () => {
    expect(runStamp('2026-06-10T18:02:11+02:00')).toBe('20260610T160211Z');
    expect(runFilename(runDoc({ createdAt: '2026-06-10T18:02:11+02:00' }))).toBe(
      'run-a11824-20260610T160211Z-3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5.json',
    );
  });

  it('rejects foreign filenames instead of crashing (C# ParseRejectsForeignFilenames)', () => {
    for (const filename of [
      'AIGrader.json',
      'run-a-bad.json',
      'run-a123-notadate-abc.json',
      'notes.txt',
      'run-a123-20260610T160211Z.json', // no runId segment at all
      'run-a12x4-20260610T160211Z-abc.json', // non-numeric assignment id
      'run-a123-20261301T000000Z-abc.json', // month 13 — calendar rollover
    ]) {
      expect(parseRunFilename(filename), filename).toBeNull();
    }
  });

  it('keeps dashes inside the runId (C# Split("-", 3) remainder semantics)', () => {
    const entry = parseRunFilename('run-a1-20250101T000000Z-abc-def.json');
    expect(entry).not.toBeNull();
    expect(entry!.runId).toBe('abc-def');
  });
});

describe('listRuns', () => {
  it('lists from filenames alone (no downloads), newest first, ignoring foreign files', async () => {
    const { files, runs } = makeRunStore();
    seedRun(files, 9, runDoc({ runId: 'aaa', createdAt: '2026-06-01T00:00:00Z', canvasCourseId: 9 }));
    seedRun(files, 9, runDoc({ runId: 'bbb', createdAt: '2026-06-15T00:00:00Z', canvasCourseId: 9 }));
    files.seedFile(9, RUNS_PATH, 'notes.txt', 'not a run');

    const entries = await runs.listRuns(9);
    expect(entries.map((e) => e.runId)).toEqual(['bbb', 'aaa']);
    expect(files.countOps('downloadFile')).toBe(0);
  });
});

describe('saveRun / loadRun', () => {
  it('persists at the canonical filename and loads back through the schema', async () => {
    const { files, runs } = makeRunStore();
    const doc = runDoc({ canvasCourseId: 9 });

    const path = await runs.saveRun(doc);
    expect(path).toBe('runs/run-a11824-20260610T160211Z-3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5.json');
    expect(files.fileText(9, RUNS_PATH, runFilename(doc))).toContain('"runId": "3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5"');

    const loaded = await runs.loadRun(9, doc.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.canvasAssignmentId).toBe(11824);
    expect(loaded!.status).toBe('PENDING');
  });

  it("routes the checkpoint to the run document's own canvasApiDomain", async () => {
    const { files, runs } = makeRunStore();
    const doc = runDoc({ canvasCourseId: 9, canvasApiDomain: 'other.instructure.com' });

    await runs.saveRun(doc);

    expect(files.fileText(9, RUNS_PATH, runFilename(doc))).toBeNull();
    const other = files.forDomain('other.instructure.com');
    expect(other.fileText(9, RUNS_PATH, runFilename(doc))).toContain('"runId"');
  });

  it('returns null for an unknown run id', async () => {
    const { runs } = makeRunStore();
    expect(await runs.loadRun(9, 'nope')).toBeNull();
  });

  it('REFUSES a course-copy orphan (fingerprint mismatch) and warns', async () => {
    const { files, runs, warnings } = makeRunStore();
    // The file sits in course 9's folder, but the document says course 777 —
    // it rode in on a Canvas course copy.
    seedRun(files, 9, runDoc({ canvasCourseId: 777 }));

    expect(await runs.loadRun(9, '3f2a9c1e2b4d54e6f8a9b0c1d2e3f4a5')).toBeNull();
    expect(warnings.some((w) => w.includes('course-copy orphan'))).toBe(true);
  });

  it('rebinds a loaded document to the launch instance (null-domain legacy docs)', async () => {
    const { files, store, runs } = makeRunStore();
    const other = files.forDomain('other.instructure.com');
    const doc = runDoc({ canvasCourseId: 9, canvasApiDomain: null });
    other.seedFile(9, RUNS_PATH, runFilename(doc), serializeStorageDocument(doc));

    const loaded = await runs.loadRun(9, doc.runId, 'other.instructure.com');
    expect(loaded).not.toBeNull();
    expect(loaded!.canvasApiDomain).toBe('other.instructure.com');
    expect(store.resolveDomain('other.instructure.com')).toBe('other.instructure.com');
  });
});

describe('deleteRun', () => {
  it('deletes the run file by id and tolerates unknown ids', async () => {
    const { files, runs } = makeRunStore();
    const doc = runDoc({ canvasCourseId: 9 });
    seedRun(files, 9, doc);

    await runs.deleteRun(9, doc.runId);
    expect(files.fileText(9, RUNS_PATH, runFilename(doc))).toBeNull();

    await runs.deleteRun(9, 'not-there'); // no throw
  });
});

describe('cleanup (retention sweep)', () => {
  it('deletes runs older than 30 days by filename date alone', async () => {
    const { files, runs } = makeRunStore('2026-07-27T12:00:00Z');
    const old = runDoc({ runId: 'old1', createdAt: '2026-06-26T00:00:00Z', canvasCourseId: 9 }); // 31+ days
    const fresh = runDoc({ runId: 'new1', createdAt: '2026-06-28T00:00:00Z', canvasCourseId: 9 }); // 29 days
    seedRun(files, 9, old);
    seedRun(files, 9, fresh);

    await runs.cleanup(9);

    expect(files.fileText(9, RUNS_PATH, runFilename(old))).toBeNull();
    expect(files.fileText(9, RUNS_PATH, runFilename(fresh))).not.toBeNull();
  });

  it('keeps only the newest 10 runs per assignment (others untouched)', async () => {
    const { files, runs } = makeRunStore('2026-07-27T12:00:00Z');
    // 12 recent runs for assignment 11824 — all within retention age.
    for (let i = 1; i <= 12; i++) {
      seedRun(
        files,
        9,
        runDoc({
          runId: `run${String(i).padStart(2, '0')}`,
          createdAt: `2026-07-${String(i).padStart(2, '0')}T00:00:00Z`,
          canvasCourseId: 9,
        }),
      );
    }
    // A different assignment keeps its single run.
    const otherAssignment = runDoc({
      runId: 'other',
      canvasAssignmentId: 42,
      createdAt: '2026-07-01T00:00:00Z',
      canvasCourseId: 9,
    });
    seedRun(files, 9, otherAssignment);

    await runs.cleanup(9);

    const remaining = (await runs.listRuns(9)).map((e) => e.runId);
    expect(remaining).toHaveLength(MAX_RUNS_PER_ASSIGNMENT + 1);
    // The two OLDEST of the twelve were removed.
    expect(remaining).not.toContain('run01');
    expect(remaining).not.toContain('run02');
    expect(remaining).toContain('run03');
    expect(remaining).toContain('run12');
    expect(remaining).toContain('other');
  });

  it('downloads only sweep survivors and deletes course-copy orphans among them', async () => {
    const { files, runs } = makeRunStore('2026-07-27T12:00:00Z');
    const orphan = runDoc({ runId: 'orphan1', createdAt: '2026-07-20T00:00:00Z', canvasCourseId: 777 });
    const native = runDoc({ runId: 'native1', createdAt: '2026-07-21T00:00:00Z', canvasCourseId: 9 });
    seedRun(files, 9, orphan);
    seedRun(files, 9, native);

    await runs.cleanup(9);

    expect(files.fileText(9, RUNS_PATH, runFilename(orphan))).toBeNull();
    expect(files.fileText(9, RUNS_PATH, runFilename(native))).not.toBeNull();
  });

  it('keeps corrupt documents (null parse) rather than guessing they are orphans', async () => {
    const { files, runs } = makeRunStore('2026-07-27T12:00:00Z');
    files.seedFile(9, RUNS_PATH, 'run-a1-20260720T000000Z-corrupt1.json', '{ not json');

    await runs.cleanup(9);

    expect(files.fileText(9, RUNS_PATH, 'run-a1-20260720T000000Z-corrupt1.json')).not.toBeNull();
  });

  it('never sweeps a run still in review or posting (bug #15)', async () => {
    const { files, runs } = makeRunStore('2026-07-27T12:00:00Z');
    // Created 40 days ago but touched yesterday: the teacher is still on it.
    const reviewing = runDoc({
      runId: 'reviewing1',
      status: 'REVIEWING',
      createdAt: '2026-06-17T00:00:00Z',
      updatedAt: '2026-07-26T00:00:00Z',
      canvasCourseId: 9,
    });
    // Same age, finished: goes.
    const done = runDoc({
      runId: 'done1',
      status: 'COMPLETED',
      createdAt: '2026-06-17T00:00:00Z',
      updatedAt: '2026-07-26T00:00:00Z',
      canvasCourseId: 9,
    });
    seedRun(files, 9, reviewing);
    seedRun(files, 9, done);

    await runs.cleanup(9);

    expect(files.fileText(9, RUNS_PATH, runFilename(reviewing))).not.toBeNull();
    expect(files.fileText(9, RUNS_PATH, runFilename(done))).toBeNull();
  });

  it('the per-assignment cap skips active overflow runs', async () => {
    const { files, runs } = makeRunStore('2026-07-27T12:00:00Z');
    for (let i = 1; i <= 11; i++) {
      seedRun(
        files,
        9,
        runDoc({
          runId: `run${String(i).padStart(2, '0')}`,
          status: i === 1 ? 'POSTING' : 'COMPLETED',
          createdAt: `2026-07-${String(i).padStart(2, '0')}T00:00:00Z`,
          updatedAt: '2026-07-20T00:00:00Z',
          canvasCourseId: 9,
        }),
      );
    }
    await runs.cleanup(9);
    const remaining = (await runs.listRuns(9)).map((e) => e.runId);
    expect(remaining).toContain('run01'); // oldest, but still posting
    expect(remaining).toHaveLength(11);
  });

  it('is best-effort: a store failure is swallowed with a warning', async () => {
    const { files, runs, warnings } = makeRunStore();
    files.seedFolder(9, RUNS_PATH);
    const broken = files.listFolderFiles.bind(files);
    files.listFolderFiles = async () => {
      files.listFolderFiles = broken;
      throw new Error('Canvas is down');
    };

    await expect(runs.cleanup(9)).resolves.toBeUndefined();
    expect(warnings.some((w) => w.includes('cleanup failed'))).toBe(true);
  });
});
