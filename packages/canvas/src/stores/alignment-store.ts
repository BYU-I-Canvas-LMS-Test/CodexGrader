// Domain store for the alignment audit document, including the history-
// management rules (cap full reports, demote overflow to trend stubs).
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\AlignmentStore.cs

import { ALIGNMENT_HISTORY_CAP, AlignmentHistoryDocumentSchema } from '@aigrader/shared';
import type { AlignmentHistoryDocument, AlignmentReport, AlignmentRunSummary } from '@aigrader/shared';
import type { CourseDocumentStore } from './course-doc-store.js';

/** The alignment audit document. */
export const ALIGNMENT_DOCUMENT_NAME = 'alignment.json';

/** Reads and appends course alignment audits.
 * `apiDomain` on every method names the Canvas instance the course lives on
 * (omitted = the document store's bound default; null = the client's base). */
export class AlignmentStore {
  constructor(private readonly store: CourseDocumentStore) {}

  /**
   * Loads the audit document; null when no audit has ever run. A course-copy
   * fingerprint mismatch also returns null: a copied alignment.json talks
   * about the ORIGIN course's assignments — treat as absent; the next audit
   * rebuilds it for this course.
   */
  async get(courseId: number, apiDomain?: string | null): Promise<AlignmentHistoryDocument | null> {
    const doc = await this.store.get(
      courseId,
      ALIGNMENT_DOCUMENT_NAME,
      AlignmentHistoryDocumentSchema,
      apiDomain,
    );
    if (doc === null) return null;
    if (doc.canvasCourseId !== courseId) return null;
    return doc;
  }

  /**
   * Appends a new report: the current Latest demotes into History; History
   * overflow past the cap demotes into Archive score-trend stubs — history
   * stays useful forever without the document growing unboundedly.
   */
  async appendReport(
    courseId: number,
    report: AlignmentReport,
    apiDomain?: string | null,
  ): Promise<AlignmentHistoryDocument> {
    return this.store.exclusive(
      courseId,
      ALIGNMENT_DOCUMENT_NAME,
      () => this.appendLocked(courseId, report, apiDomain),
      apiDomain,
    );
  }

  private async appendLocked(
    courseId: number,
    report: AlignmentReport,
    apiDomain?: string | null,
  ): Promise<AlignmentHistoryDocument> {
    const doc =
      (await this.get(courseId, apiDomain)) ??
      AlignmentHistoryDocumentSchema.parse({ canvasCourseId: courseId });

    if (doc.latest !== null) doc.history.unshift(doc.latest);

    while (doc.history.length > ALIGNMENT_HISTORY_CAP) {
      const demoted = doc.history.pop() as AlignmentReport;
      const stub: AlignmentRunSummary = {
        scannedAt: demoted.scannedAt,
        method: demoted.method,
        alignmentScore: demoted.alignmentScore,
        issueCount: demoted.issues.length,
        highSeverityCount: demoted.issues.filter((i) => i.severity === 'high').length,
      };
      doc.archive.unshift(stub);
    }

    doc.latest = report;
    await this.store.put(courseId, ALIGNMENT_DOCUMENT_NAME, doc, apiDomain);
    return doc;
  }
}
