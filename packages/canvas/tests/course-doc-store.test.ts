// CourseDocumentStore behavior: per-(instance, course) write-gate
// serialization, "AI Grader" folder resolution + decision caching,
// hidden+locked folder creation, the TTL read cache, and corrupt-document
// tolerance.
// Behaviors ported from:
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\CourseDocumentStore.cs

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serializeStorageDocument } from '@aigrader/shared';
import { CourseDocumentStore, ROOT_FOLDER_NAME } from '../src/stores/course-doc-store.js';
import { FakeFilesClient, settle } from './stores-helpers.js';

const docSchema = z.object({ value: z.string() }).passthrough();

function makeStore(overrides: { now?: () => Date } = {}) {
  const files = new FakeFilesClient();
  const warnings: string[] = [];
  const store = new CourseDocumentStore({
    files,
    warn: (m) => warnings.push(m),
    ...overrides,
  });
  return { files, store, warnings };
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('write gate', () => {
  it('serializes concurrent writes to the SAME course (no interleaving)', async () => {
    const { files, store } = makeStore();
    files.manualUploads = true;

    const p1 = store.putFile(9, 'a.json', 'application/json', enc('{"n":1}'));
    const p2 = store.putFile(9, 'b.json', 'application/json', enc('{"n":2}'));
    await settle();

    // Only the first write reached the files client; the second is queued
    // behind the per-course gate.
    expect(files.pendingUploadLabels).toEqual(['9:a.json']);

    files.releaseNextUpload();
    await settle();
    expect(files.pendingUploadLabels).toEqual(['9:b.json']);

    files.releaseNextUpload();
    await Promise.all([p1, p2]);

    const uploads = files.ops.filter((op) => op.startsWith('uploadFile:'));
    expect(uploads).toEqual([
      'uploadFile:start:9:a.json',
      'uploadFile:end:9:a.json',
      'uploadFile:start:9:b.json',
      'uploadFile:end:9:b.json',
    ]);
  });

  it('lets writes to DIFFERENT courses interleave', async () => {
    const { files, store } = makeStore();
    files.manualUploads = true;

    const p1 = store.putFile(9, 'a.json', 'application/json', enc('{}'));
    const p2 = store.putFile(10, 'a.json', 'application/json', enc('{}'));
    await settle();

    // Both uploads are in flight simultaneously — separate course gates.
    expect(files.pendingUploadLabels).toEqual(['9:a.json', '10:a.json']);

    files.releaseNextUpload();
    files.releaseNextUpload();
    await Promise.all([p1, p2]);
  });

  it('keys gates by (instance, course) — the same courseId on two instances interleaves', async () => {
    const { files, store } = makeStore();
    files.manualUploads = true;

    const p1 = store.putFile(9, 'a.json', 'application/json', enc('{}'));
    const p2 = store.putFile(9, 'a.json', 'application/json', enc('{}'), 'other.instructure.com');
    await settle();

    expect(files.pendingUploadLabels).toEqual(['9:a.json', '9:a.json']);
    files.releaseNextUpload();
    files.releaseNextUpload();
    await Promise.all([p1, p2]);
  });

  it('releases the gate when a write throws (next write still runs)', async () => {
    const { files, store } = makeStore();

    await expect(
      store.putFile(9, 'too/deep/path.json', 'application/json', enc('{}')),
    ).rejects.toThrow(/one subfolder level/);

    await store.put(9, 'ok.json', { value: 'fine' });
    expect(files.fileText(9, ROOT_FOLDER_NAME, 'ok.json')).toContain('"fine"');
  });
});

describe('folder resolution', () => {
  it('uses the "AI Grader" folder — the same one the C# BYU-(A)I Grader used', () => {
    expect(ROOT_FOLDER_NAME).toBe('AI Grader');
  });

  it('creates the "AI Grader" root hidden+locked for a fresh course', async () => {
    const { files, store } = makeStore();

    await store.put(9, 'AIGrader.json', { value: 'x' });

    const folder = files.folderByPath(9, ROOT_FOLDER_NAME);
    expect(folder).toBeDefined();
    expect(folder!.hidden).toBe(true);
    expect(folder!.locked).toBe(true);
  });

  it('reads an existing "AI Grader" folder (C#-written data) in place, creating nothing', async () => {
    const { files, store } = makeStore();
    files.seedFile(9, ROOT_FOLDER_NAME, 'AIGrader.json', serializeStorageDocument({ value: 'from-csharp' }));

    const doc = await store.get(9, 'AIGrader.json', docSchema);
    expect(doc?.value).toBe('from-csharp');
    expect(files.countOps('ensureFolder')).toBe(0);
  });

  it('reads a SUBFOLDER (runs) through the root', async () => {
    const { files, store } = makeStore();
    files.seedFile(9, `${ROOT_FOLDER_NAME}/runs`, 'run-x.json', '{}');

    const listing = await store.list(9, 'runs');
    expect(listing.map((f) => f.filename)).toEqual(['run-x.json']);
  });

  it('returns null/empty for a never-touched course without creating anything', async () => {
    const { files, store } = makeStore();

    expect(await store.get(9, 'AIGrader.json', docSchema)).toBeNull();
    expect(await store.list(9, 'runs')).toEqual([]);
    expect(files.countOps('ensureFolder')).toBe(0);
  });

  it('never probes, creates, or writes any other folder name', async () => {
    const { files, store } = makeStore();

    await store.get(9, 'AIGrader.json', docSchema);
    await store.put(9, 'AIGrader.json', { value: 'x' });
    await store.put(9, 'runs/run-y.json', { value: 'y' });

    const folderOps = files.ops.filter(
      (op) => op.startsWith('findFolderByPath:') || op.startsWith('ensureFolder:'),
    );
    expect(folderOps.length).toBeGreaterThan(0);
    for (const op of folderOps) {
      expect(op).toContain(ROOT_FOLDER_NAME);
    }
  });

  it('caches the per-course folder decision (no re-probing on later calls)', async () => {
    const { files, store } = makeStore();
    files.seedFile(9, ROOT_FOLDER_NAME, 'AIGrader.json', serializeStorageDocument({ value: 'x' }));

    await store.get(9, 'AIGrader.json', docSchema);
    const probesAfterFirst = files.countOps('findFolderByPath');
    expect(probesAfterFirst).toBe(1); // the root folder found on the first probe

    await store.get(9, 'resources.json', docSchema); // different doc, same course
    await store.list(9, 'runs');
    // The root decision is cached; only the runs SUBFOLDER needed one lookup.
    const exact = (op: string) => files.ops.filter((o) => o === op).length;
    expect(exact(`findFolderByPath:9:${ROOT_FOLDER_NAME}`)).toBe(1);
    expect(exact(`findFolderByPath:9:${ROOT_FOLDER_NAME}/runs`)).toBe(1);
  });
});

describe('document cache + serialization', () => {
  it('serves reads write-through after a put (no download)', async () => {
    const { files, store } = makeStore();

    await store.put(9, 'AIGrader.json', { value: 'cached' });
    const doc = await store.get(9, 'AIGrader.json', docSchema);

    expect(doc?.value).toBe('cached');
    expect(files.countOps('downloadFile')).toBe(0);
  });

  it('expires cached documents after the TTL (clock-driven)', async () => {
    let nowMs = Date.UTC(2026, 6, 1);
    const { files, store } = makeStore({ now: () => new Date(nowMs) });

    await store.put(9, 'AIGrader.json', { value: 'v1' });
    nowMs += 16 * 60 * 1000; // past the 15-minute document TTL

    await store.get(9, 'AIGrader.json', docSchema);
    expect(files.countOps('downloadFile')).toBe(1);
  });

  it('writes documents through the shared storage serializer (2-space indent, nulls omitted)', async () => {
    const { files, store } = makeStore();

    await store.put(9, 'AIGrader.json', { value: 'x', gone: null, nested: { keep: 1 } });

    const text = files.fileText(9, ROOT_FOLDER_NAME, 'AIGrader.json');
    expect(text).toBe(
      serializeStorageDocument({ value: 'x', gone: null, nested: { keep: 1 } }),
    );
    expect(text).toContain('  "value": "x"');
    expect(text).not.toContain('gone');
  });

  it('returns null (with a warning) for a corrupt document instead of throwing', async () => {
    const { files, store, warnings } = makeStore();
    files.seedFile(9, ROOT_FOLDER_NAME, 'AIGrader.json', 'not json at all {');

    expect(await store.get(9, 'AIGrader.json', docSchema)).toBeNull();
    expect(warnings.some((w) => w.includes('AIGrader.json'))).toBe(true);
  });

  it('delete removes the file and drops the cached copy', async () => {
    const { files, store } = makeStore();
    await store.put(9, 'AIGrader.json', { value: 'x' });

    await store.delete(9, 'AIGrader.json');

    expect(files.fileText(9, ROOT_FOLDER_NAME, 'AIGrader.json')).toBeNull();
    expect(await store.get(9, 'AIGrader.json', docSchema)).toBeNull();
  });
});

describe('forDomain scoping', () => {
  it('routes per-call apiDomain to the right instance and shares gates across views', async () => {
    const { files, store } = makeStore();

    await store.put(9, 'AIGrader.json', { value: 'default' });
    await store.put(9, 'AIGrader.json', { value: 'other' }, 'other.instructure.com');

    expect(files.fileText(9, ROOT_FOLDER_NAME, 'AIGrader.json')).toContain('"default"');
    const otherFiles = files.forDomain('other.instructure.com');
    expect(otherFiles.fileText(9, ROOT_FOLDER_NAME, 'AIGrader.json')).toContain('"other"');

    // A domain-bound sibling reads the same data (and the same caches).
    const scoped = store.forDomain('other.instructure.com');
    expect(scoped).not.toBe(store);
    expect(scoped.apiDomain).toBe('other.instructure.com');
    const doc = await scoped.get(9, 'AIGrader.json', docSchema);
    expect(doc?.value).toBe('other');

    // Null/empty stays on the same store (the bound default).
    expect(store.forDomain(null)).toBe(store);
    expect(store.forDomain(undefined)).toBe(store);
  });
});
