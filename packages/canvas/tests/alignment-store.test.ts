// AlignmentStore behavior: the Latest → History (cap 10) → Archive stub
// demotion rules and the course-copy fingerprint reset.
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\AlignmentStore.cs

import { describe, expect, it } from 'vitest';
import { ALIGNMENT_HISTORY_CAP, AlignmentReportSchema, serializeStorageDocument } from '@aigrader/shared';
import type { AlignmentReport } from '@aigrader/shared';
import { ALIGNMENT_DOCUMENT_NAME, AlignmentStore } from '../src/stores/alignment-store.js';
import { CourseDocumentStore, ROOT_FOLDER_NAME } from '../src/stores/course-doc-store.js';
import { FakeFilesClient } from './stores-helpers.js';

function makeAlignmentStore() {
  const files = new FakeFilesClient();
  const store = new CourseDocumentStore({ files, warn: () => {} });
  const alignments = new AlignmentStore(store);
  return { files, store, alignments };
}

function report(n: number, issues: Array<'high' | 'medium' | 'low'> = []): AlignmentReport {
  return AlignmentReportSchema.parse({
    method: 'ai',
    scannedAt: `2026-07-${String(n).padStart(2, '0')}T00:00:00Z`,
    alignmentScore: n,
    issues: issues.map((severity) => ({ severity, assignment: 'Essay', title: 'x' })),
  });
}

describe('get', () => {
  it('returns null when no audit has ever run', async () => {
    const { alignments } = makeAlignmentStore();
    expect(await alignments.get(9)).toBeNull();
  });

  it('returns null on a course-copy fingerprint mismatch (stale audit)', async () => {
    const { files, alignments } = makeAlignmentStore();
    files.seedFile(
      9,
      ROOT_FOLDER_NAME,
      ALIGNMENT_DOCUMENT_NAME,
      serializeStorageDocument({ schemaVersion: 1, canvasCourseId: 777, latest: report(1) }),
    );

    expect(await alignments.get(9)).toBeNull();
  });
});

describe('appendReport', () => {
  it('sets Latest on the first audit (fresh document carries the course fingerprint)', async () => {
    const { files, alignments } = makeAlignmentStore();

    const doc = await alignments.appendReport(9, report(1));

    expect(doc.canvasCourseId).toBe(9);
    expect(doc.latest?.alignmentScore).toBe(1);
    expect(doc.history).toEqual([]);
    expect(doc.archive).toEqual([]);
    expect(files.fileText(9, ROOT_FOLDER_NAME, ALIGNMENT_DOCUMENT_NAME)).toContain('"canvasCourseId": 9');
  });

  it('demotes the previous Latest into History, newest first', async () => {
    const { alignments } = makeAlignmentStore();

    await alignments.appendReport(9, report(1));
    await alignments.appendReport(9, report(2));
    const doc = await alignments.appendReport(9, report(3));

    expect(doc.latest?.alignmentScore).toBe(3);
    expect(doc.history.map((r) => r.alignmentScore)).toEqual([2, 1]);
    expect(doc.archive).toEqual([]);
  });

  it('caps History at 10 and demotes overflow into Archive trend stubs', async () => {
    const { alignments } = makeAlignmentStore();

    // Report 1 carries issues so its eventual stub has counts to verify.
    await alignments.appendReport(9, report(1, ['high', 'high', 'low']));
    for (let n = 2; n <= 13; n++) {
      await alignments.appendReport(9, report(n));
    }

    const doc = (await alignments.get(9))!;
    expect(doc.latest?.alignmentScore).toBe(13);
    expect(doc.history).toHaveLength(ALIGNMENT_HISTORY_CAP);
    // History holds the 10 most recent priors (12..3); 1 and 2 were demoted.
    expect(doc.history.map((r) => r.alignmentScore)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);

    expect(doc.archive).toHaveLength(2);
    // Archive is newest-first too: report 2 demoted after report 1.
    expect(doc.archive[0].alignmentScore).toBe(2);
    expect(doc.archive[1].alignmentScore).toBe(1);
    expect(doc.archive[1].scannedAt).toBe('2026-07-01T00:00:00Z');
    expect(doc.archive[1].method).toBe('ai');
    expect(doc.archive[1].issueCount).toBe(3);
    expect(doc.archive[1].highSeverityCount).toBe(2);
  });

  it('starts a FRESH document after a course copy instead of extending the stale one', async () => {
    const { files, alignments } = makeAlignmentStore();
    files.seedFile(
      9,
      ROOT_FOLDER_NAME,
      ALIGNMENT_DOCUMENT_NAME,
      serializeStorageDocument({
        schemaVersion: 1,
        canvasCourseId: 777, // origin course — copied in
        latest: report(1),
        history: [report(2)],
      }),
    );

    const doc = await alignments.appendReport(9, report(5));

    expect(doc.canvasCourseId).toBe(9);
    expect(doc.latest?.alignmentScore).toBe(5);
    expect(doc.history).toEqual([]); // the origin course's reports are gone
    expect(doc.archive).toEqual([]);
  });
});
