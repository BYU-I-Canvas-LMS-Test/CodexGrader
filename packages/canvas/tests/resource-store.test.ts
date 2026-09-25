// ResourceStore behavior: deterministic material filenames
// (a{assignmentId}-{kind}{.ext}), resolution by FILENAME with canvasFileId as
// a mere cache (the relink-by-name property that survives course copies),
// the material byte cache, and per-assignment prep settings.
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\ResourceStore.cs

import { describe, expect, it } from 'vitest';
import { AssignmentPrepSettingsSchema } from '@aigrader/shared';
import { CourseDocumentStore, ROOT_FOLDER_NAME } from '../src/stores/course-doc-store.js';
import {
  RESOURCES_DOCUMENT_NAME,
  ResourceStore,
  materialFilename,
} from '../src/stores/resource-store.js';
import { FakeFilesClient } from './stores-helpers.js';

function makeResourceStore(now?: () => Date) {
  const files = new FakeFilesClient();
  const clock = now ?? (() => new Date('2026-07-27T12:00:00Z'));
  const store = new CourseDocumentStore({ files, now: clock, warn: () => {} });
  const resources = new ResourceStore({ store, now: clock });
  return { files, store, resources };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('materialFilename (deterministic naming)', () => {
  it('builds a{assignmentId}-{kind}{.ext} with a lowercased extension', () => {
    expect(materialFilename(11824, 'KEY', 'Answer Key.XLSX')).toBe('a11824-key.xlsx');
    expect(materialFilename(11824, 'TEMPLATE', 'starter.docx')).toBe('a11824-template.docx');
    expect(materialFilename(7, 'KEY', 'weird.name.PDF')).toBe('a7-key.pdf');
    // C# Path.GetExtension edge cases: no dot / trailing dot → no extension.
    expect(materialFilename(7, 'KEY', 'README')).toBe('a7-key');
    expect(materialFilename(7, 'KEY', 'dotless.')).toBe('a7-key');
  });
});

describe('uploadMaterial', () => {
  it('stores bytes under the deterministic name and records metadata in resources.json', async () => {
    const { files, resources } = makeResourceStore();

    const entry = await resources.uploadMaterial(
      9,
      11824,
      'Essay 1',
      'KEY',
      'My Key.XLSX',
      'application/vnd.ms-excel',
      bytes('key-bytes'),
    );

    expect(entry.fileName).toBe('a11824-key.xlsx');
    expect(entry.assignmentName).toBe('Essay 1');
    expect(entry.originalFilename).toBe('My Key.XLSX');
    expect(entry.uploadedAt).toBe('2026-07-27T12:00:00.000Z');
    expect(entry.canvasFileId).toBeGreaterThan(0);

    expect(files.fileText(9, ROOT_FOLDER_NAME, 'a11824-key.xlsx')).toBe('key-bytes');
    const doc = JSON.parse(files.fileText(9, ROOT_FOLDER_NAME, RESOURCES_DOCUMENT_NAME)!) as {
      canvasCourseId: number;
      resources: Array<{ fileName: string; kind: string }>;
    };
    expect(doc.canvasCourseId).toBe(9);
    expect(doc.resources).toHaveLength(1);
    expect(doc.resources[0].fileName).toBe('a11824-key.xlsx');
    expect(doc.resources[0].kind).toBe('KEY');
  });

  it('re-upload replaces the previous entry for the same (assignment, kind) — no duplicates', async () => {
    const { resources } = makeResourceStore();

    await resources.uploadMaterial(9, 11824, 'Essay 1', 'KEY', 'v1.pdf', 'application/pdf', bytes('v1'));
    await resources.uploadMaterial(9, 11824, 'Essay 1', 'KEY', 'v2.pdf', 'application/pdf', bytes('v2'));
    await resources.uploadMaterial(9, 11824, 'Essay 1', 'TEMPLATE', 't.docx', 'application/msword', bytes('t'));

    const list = await resources.list(9);
    expect(list).toHaveLength(2);
    const key = list.find((r) => r.kind === 'KEY');
    expect(key?.originalFilename).toBe('v2.pdf');

    const downloaded = await resources.downloadMaterial(9, 11824, 'KEY');
    expect(new TextDecoder().decode(downloaded!)).toBe('v2');
  });
});

describe('downloadMaterial (relink-by-name)', () => {
  it('resolves by FILENAME even when the recorded canvasFileId is stale (course copy / overwrite)', async () => {
    const { files, resources } = makeResourceStore();
    const entry = await resources.uploadMaterial(
      9, 11824, 'Essay 1', 'KEY', 'key.pdf', 'application/pdf', bytes('the-key'),
    );

    // Simulate Canvas reassigning the file id (overwrite or course copy):
    // the id recorded in resources.json no longer exists.
    const newId = files.reassignFileId(9, ROOT_FOLDER_NAME, 'a11824-key.pdf');
    expect(newId).not.toBe(entry.canvasFileId);

    const downloaded = await resources.downloadMaterial(9, 11824, 'KEY');
    expect(new TextDecoder().decode(downloaded!)).toBe('the-key');
    // The stale recorded id was never used for the download.
    expect(files.ops).not.toContain(`downloadFile:${entry.canvasFileId}`);
    expect(files.ops).toContain(`downloadFile:${newId}`);
  });

  it('returns null when nothing was uploaded for that (assignment, kind)', async () => {
    const { resources } = makeResourceStore();
    expect(await resources.downloadMaterial(9, 11824, 'KEY')).toBeNull();
  });

  it('serves repeat downloads from the byte cache (one Canvas download per run)', async () => {
    const { files, resources } = makeResourceStore();
    await resources.uploadMaterial(9, 11824, 'Essay 1', 'KEY', 'key.pdf', 'application/pdf', bytes('k'));

    await resources.downloadMaterial(9, 11824, 'KEY');
    await resources.downloadMaterial(9, 11824, 'KEY');
    await resources.downloadMaterial(9, 11824, 'KEY');

    expect(files.countOps('downloadFile')).toBe(1);
  });
});

describe('deleteMaterial', () => {
  it('removes the file AND its metadata entry', async () => {
    const { files, resources } = makeResourceStore();
    await resources.uploadMaterial(9, 11824, 'Essay 1', 'KEY', 'key.pdf', 'application/pdf', bytes('k'));

    await resources.deleteMaterial(9, 11824, 'KEY');

    expect(files.fileText(9, ROOT_FOLDER_NAME, 'a11824-key.pdf')).toBeNull();
    expect(await resources.list(9)).toEqual([]);
    expect(await resources.downloadMaterial(9, 11824, 'KEY')).toBeNull();
  });

  it('is a no-op when the material does not exist', async () => {
    const { resources } = makeResourceStore();
    await expect(resources.deleteMaterial(9, 11824, 'KEY')).resolves.toBeUndefined();
  });
});

describe('prep settings', () => {
  it('returns defaults when unset', async () => {
    const { resources } = makeResourceStore();

    const prep = await resources.getPrep(9, 11824);

    expect(prep.customInstructions).toBe('');
    expect(prep.shareRubric).toBe(true);
    expect(prep.shareInstructions).toBe(true);
  });

  it('round-trips saved prep, keyed by stringified assignment id', async () => {
    const { files, resources } = makeResourceStore();

    await resources.savePrep(9, 11824, {
      customInstructions: 'Grade gently.',
      shareRubric: false,
      shareInstructions: true,
    });

    const prep = await resources.getPrep(9, 11824);
    expect(prep.customInstructions).toBe('Grade gently.');
    expect(prep.shareRubric).toBe(false);

    const doc = JSON.parse(files.fileText(9, ROOT_FOLDER_NAME, RESOURCES_DOCUMENT_NAME)!) as {
      prep: Record<string, unknown>;
    };
    expect(Object.keys(doc.prep)).toEqual(['11824']); // JSON keys are strings (C# parity)

    // Other assignments still get defaults.
    expect((await resources.getPrep(9, 555)).customInstructions).toBe('');
  });
});

describe('concurrent read-modify-write (bug #11)', () => {
  it('two prep saves for different assignments racing each other both survive', async () => {
    const { resources } = makeResourceStore();
    const prep = (text: string) => AssignmentPrepSettingsSchema.parse({ customInstructions: text });
    await Promise.all([
      resources.savePrep(9, 101, prep('first')),
      resources.savePrep(9, 202, prep('second')),
      resources.savePrep(9, 303, prep('third')),
    ]);
    expect((await resources.getPrep(9, 101)).customInstructions).toBe('first');
    expect((await resources.getPrep(9, 202)).customInstructions).toBe('second');
    expect((await resources.getPrep(9, 303)).customInstructions).toBe('third');
  });
});
