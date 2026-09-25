// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\GraderAgent.cs
// (itself a flattening of the TS LangGraph graph, lib\agents\grader\graph.ts).
//
// The per-submission grading pipeline: download → extract → assemble → build
// prompt → LLM → map to draft. One call per student; GRADE_CONCURRENCY run
// concurrently via the engine's p-queue. Drives the row through EXTRACTING →
// SCORING → DRAFT, or to ERROR with a faculty-readable message.
//
// Error semantics (the C# split, preserved):
//   - TRANSIENT failures (attachment download, Canvas hiccups) THROW — the
//     row lands in ERROR and is re-runnable (a re-run may succeed).
//   - DETERMINISTIC extraction failures (unsupported format, corrupt file)
//     become inline "[This file could not be read: …]" notes + extraction
//     warnings in a multi-file submission (the rest still grades); a
//     single-file submission keeps the hard-error behavior (assembly throws).
//   - Cancellation leaves the row in its in-flight state — resume
//     reconciliation resets EXTRACTING/SCORING rows to PENDING.
//   - RUN-LEVEL failures (Codex usage limit / sign-in, Canvas token rejected)
//     put the row back to PENDING and signal a pause (coordinator/pause.ts)
//     instead of erroring every row the same way.
//
// Inputs come from the run's prepSnapshot (frozen at run start) when present;
// runs written before snapshots existed fall back to live reads.

import { Buffer } from 'node:buffer';
import type { CanvasSubmission, DiscussionEntry } from '@aigrader/canvas';
import { extractOnlineTextEntry, extractSubmissionText } from '@aigrader/extraction';
import type {
  AssignmentPrepSettings,
  AssignmentResourceEntry,
  CourseSettingsProfile,
  GradingRunDocument,
  ResourceKind,
} from '@aigrader/shared';
import { renderCourseProfileText } from '@aigrader/shared';
import type { GradingLlm, LlmResult } from '../llm/structured-client.js';
import type { GraderOutput } from '../llm/response-schemas.js';
import type { RunSession } from '../coordinator/run-session.js';
import { pauseSignalOf, type PauseSignal } from '../coordinator/pause.js';
import { assembleSubmission, isExcelFilename } from './submission-assembly.js';
import type { SubmissionFileInput, VisionImagePart } from './submission-assembly.js';
import { isImageAttachment } from './vision-routing.js';
import { compareToKey, summarizeComparison } from './excel-key.js';
import { DiscussionAggregator } from './discussion-aggregator.js';
import { enforceAssignmentScale, hasMixedIds, toDraft } from './rubric-draft-mapper.js';
import { composeSystemPrompt } from './prompts/system-prompt.js';
import { buildUserMessage } from './prompts/user-template.js';
import { stripHtml } from './prompts/strip-html.js';

/** Max characters of extracted text persisted to the run document. The full
 * text goes to the LLM; only this excerpt is stored (PII minimization +
 * checkpoint size control). C# GraderAgent.ExcerptLength. */
export const EXCERPT_LENGTH = 2000;

// ------------------------------------------------------------------- ports --

/** The Canvas calls this pipeline makes (structural — CanvasClient bound to
 * the run's instance satisfies it; tests pass plain objects). */
export interface GraderCanvasPort {
  getSubmission(
    courseId: number,
    assignmentId: number,
    userId: number,
    opts?: { include?: readonly string[] },
  ): Promise<CanvasSubmission | null>;
  downloadUrl(url: string): Promise<Buffer>;
  getDiscussionEntries(courseId: number, topicId: number): Promise<DiscussionEntry[]>;
}

export interface ProfileStorePort {
  get(courseId: number, apiDomain?: string | null): Promise<CourseSettingsProfile>;
}

export interface ResourceStorePort {
  getPrep(
    courseId: number,
    assignmentId: number,
    apiDomain?: string | null,
  ): Promise<AssignmentPrepSettings>;
  downloadMaterial(
    courseId: number,
    assignmentId: number,
    kind: ResourceKind,
    apiDomain?: string | null,
  ): Promise<Uint8Array | null>;
  list(courseId: number, apiDomain?: string | null): Promise<AssignmentResourceEntry[]>;
}

export interface GraderAgentDeps {
  canvas: GraderCanvasPort;
  profiles: ProfileStorePort;
  resources: ResourceStorePort;
  discussions: DiscussionAggregator;
  llm: Pick<GradingLlm, 'gradeSubmission'>;
  config: {
    model: string;
    reasoningEffort?: string;
    maxOutputTokens?: number;
  };
  warn?: (message: string) => void;
}

export interface GradeOneOptions {
  /** Aborts the in-flight LLM call (cancel / shutdown). */
  signal?: AbortSignal;
  /** Cancel flag checked at step boundaries; when it flips, the row is left
   * in its in-flight state (resume/cancel finalization owns it). */
  isCancelled?: () => boolean;
  /** Called when a failure should pause the whole run (the row is already
   * back to PENDING). */
  onPause?: (signal: PauseSignal) => void;
}

/** What one submission's extraction produced (pipeline-internal). */
type SubmissionContent = {
  text: string;
  excelFileBytes: Buffer | null;
  excelFilename: string | null;
  images: VisionImagePart[];
  warnings: string[];
};

// ------------------------------------------------------------------ agent --

/** Produces one AI draft for one student's submission. */
export class GraderAgent {
  private readonly deps: GraderAgentDeps;
  private readonly warn: (message: string) => void;

  constructor(deps: GraderAgentDeps) {
    this.deps = deps;
    this.warn = deps.warn ?? ((message) => console.warn(message));
  }

  /**
   * Grades one student. Never throws (except on internal bugs): failures
   * land on the row as ERROR; cancellation leaves the row in-flight.
   */
  async gradeOne(
    session: RunSession,
    canvasUserId: number,
    opts: GradeOneOptions = {},
  ): Promise<void> {
    const doc = session.document;
    const cancelled = () => opts.isCancelled?.() === true || opts.signal?.aborted === true;
    if (cancelled()) return;

    try {
      // --- extract ----------------------------------------------------
      session.updateGrade(canvasUserId, (g) => {
        g.status = 'EXTRACTING';
      });

      const content = await this.extractSubmission(doc, canvasUserId);
      if (cancelled()) return;

      session.updateGrade(canvasUserId, (g) => {
        g.submissionExcerpt =
          content.text.length <= EXCERPT_LENGTH
            ? content.text
            : content.text.slice(0, EXCERPT_LENGTH);
        g.excerptTruncated = content.text.length > EXCERPT_LENGTH;
        g.extractionWarnings = [...content.warnings];
        g.status = 'SCORING';
      });

      // --- prep + materials -------------------------------------------
      // The run-start snapshot wins (a mid-run prep edit must not change
      // later drafts); legacy runs without one read live.
      const prep = doc.prepSnapshot
        ? {
            customInstructions: doc.prepSnapshot.customInstructions,
            shareRubric: doc.prepSnapshot.shareRubric,
            shareInstructions: doc.prepSnapshot.shareInstructions,
          }
        : await this.deps.resources.getPrep(
            doc.canvasCourseId,
            doc.canvasAssignmentId,
            doc.canvasApiDomain,
          );
      const materials = await this.loadMaterials(doc, content);

      // The run's one-off notes layer on top of the standing per-assignment
      // instructions from the Prepare screen.
      const instructions = [prep.customInstructions, doc.additionalInstructions]
        .filter((s): s is string => s != null && s.trim() !== '')
        .join('\n');

      // --- prompt -----------------------------------------------------
      const profileText =
        doc.prepSnapshot?.profileText ??
        renderCourseProfileText(
          await this.deps.profiles.get(doc.canvasCourseId, doc.canvasApiDomain),
        );

      const systemPrompt = composeSystemPrompt({
        vision: content.images.length > 0,
        mixedRubricIds: hasMixedIds(doc.rubricSnapshot),
      });

      const userMessage = buildUserMessage({
        courseSettingsText: profileText,
        cleanedAssignmentText: prep.shareInstructions
          ? stripHtml(doc.assignmentDescriptionHtml ?? '')
          : '',
        rubric: prep.shareRubric ? doc.rubricSnapshot : null,
        studentSubmissionText: content.text,
        additionalInstructions: instructions.length > 0 ? instructions : null,
        providedTemplateText: materials.templateText,
        gradingKeyText: materials.keyText,
        excelKeyComparison: materials.excelComparison,
        pointsPossible: doc.pointsPossible,
      });

      if (cancelled()) return;

      // --- LLM (transient retry lives inside the structured client) ----
      const result: LlmResult<GraderOutput> = await this.deps.llm.gradeSubmission({
        systemPrompt,
        userMessage,
        images: content.images.map((img) => ({
          mimeType: img.mediaType,
          base64: Buffer.from(img.bytes).toString('base64'),
        })),
        criteria: doc.rubricSnapshot.map((c) => ({
          id: c.id,
          ratingIds: (c.ratings ?? []).map((r) => r.id),
        })),
        model: this.deps.config.model,
        reasoningEffort: this.deps.config.reasoningEffort,
        maxOutputTokens: this.deps.config.maxOutputTokens,
        signal: opts.signal,
      });

      // --- map + draft --------------------------------------------------
      // Scale guarantee (no-rubric runs): the prompt states the assignment's
      // point value, but if the model still grades on an invented scale the
      // score is rescaled/clamped to the real one and faculty see a warning
      // on the review card. Runs before toDraft — the correction needs the
      // model's own denominator.
      const scaleNote = enforceAssignmentScale(
        result.output,
        doc.rubricSnapshot,
        doc.pointsPossible,
      );

      const draft = toDraft(result.output, doc.rubricSnapshot, doc.pointsPossible);
      session.updateGrade(canvasUserId, (g) => {
        g.aiDraft = draft;
        // A kept faculty edit now predates this draft (re-run) — the reviewer
        // decides whether to keep or discard it.
        if (g.facultyEdited != null) g.staleEdit = true;
        g.errorKind = undefined;
        if (scaleNote != null) g.extractionWarnings.push(scaleNote);
        g.llm = {
          inputTokens: result.stats.promptTokens ?? 0,
          outputTokens: result.stats.outputTokens ?? 0,
          latencyMs: result.stats.durationMs,
          ...(result.stats.cachedTokens !== undefined
            ? { cachedTokens: result.stats.cachedTokens }
            : {}),
          ...(result.stats.thoughtsTokens !== undefined
            ? { thoughtsTokens: result.stats.thoughtsTokens }
            : {}),
        };
        g.status = g.facultyEdited != null ? 'EDITED' : 'DRAFT';
        g.errorMessage = null;
      });
    } catch (err) {
      if (cancelled()) return; // leave the row in-flight; cancel/resume owns it
      const pause = pauseSignalOf(err);
      if (pause) {
        session.updateGrade(canvasUserId, (g) => {
          g.status = 'PENDING';
        });
        opts.onPause?.(pause);
        return;
      }
      session.updateGrade(canvasUserId, (g) => {
        g.status = 'ERROR';
        g.errorKind = 'grade';
        g.errorMessage = err instanceof Error ? err.message : String(err);
      });
    }
  }

  // -------------------------------------------------------------- extract --

  private async extractSubmission(
    doc: GradingRunDocument,
    canvasUserId: number,
  ): Promise<SubmissionContent> {
    // Discussion runs: the "submission" is the student's aggregated posts
    // (cached per topic, so one thread fetch serves the whole run).
    if (doc.canvasDiscussionTopicId != null) {
      const posts = await this.deps.discussions.getStudentTexts(
        this.deps.canvas,
        doc.canvasCourseId,
        doc.canvasDiscussionTopicId,
        doc.canvasApiDomain,
      );
      const text = posts.get(canvasUserId);
      if (text == null || text.trim() === '') {
        throw new Error('The student has no posts in this discussion.');
      }
      return {
        text,
        excelFileBytes: null,
        excelFilename: null,
        images: [],
        warnings: [],
      };
    }

    // The signed attachment URL recorded at fan-out has expired by now —
    // re-fetch the submission for a fresh one. (Stored URLs are never trusted.)
    const submission = await this.deps.canvas.getSubmission(
      doc.canvasCourseId,
      doc.canvasAssignmentId,
      canvasUserId,
    );
    if (submission == null) {
      throw new Error('Submission no longer exists in Canvas.');
    }

    if (
      submission.submission_type === 'online_text_entry' &&
      typeof submission.body === 'string' &&
      submission.body.trim() !== ''
    ) {
      const text = extractOnlineTextEntry(submission.body);
      return {
        text,
        excelFileBytes: null,
        excelFilename: null,
        images: [],
        warnings: [],
      };
    }

    const attachments = submission.attachments ?? [];
    if (attachments.length > 0) {
      // ALL attachments grade together in one call: document texts as
      // labeled sections, images as vision parts (submission-assembly).
      // Unreadable files in a multi-file submission become inline notes;
      // DOWNLOAD failures throw so the student lands in ERROR (re-runnable).
      const files: SubmissionFileInput[] = [];
      const extractionWarnings: string[] = [];
      let excelFileBytes: Buffer | null = null;

      for (const att of attachments) {
        const filename = att.filename ?? att.display_name ?? 'file';
        const mediaType = att['content-type'] ?? null;
        if (!att.url) {
          throw new Error(`Could not download '${filename}': Canvas provided no download URL.`);
        }
        const bytes = await this.deps.canvas.downloadUrl(att.url); // throws → row ERROR

        if (isImageAttachment(mediaType, filename)) {
          files.push({ filename, mediaType, imageBytes: bytes });
          continue;
        }

        try {
          const extracted = await extractSubmissionText(filename, bytes, { mime: mediaType });
          if (extracted.text.trim() === '' && extracted.warnings.length > 0) {
            // e.g. a scanned PDF: the extractor's own explanation beats the
            // generic "no extractable text" (single file → that message is the
            // ERROR; multi-file → an inline note + amber warning).
            files.push({ filename, mediaType, error: extracted.warnings.join(' ') });
            continue;
          }
          files.push({ filename, mediaType, text: extracted.text });
          for (const warning of extracted.warnings) {
            extractionWarnings.push(`${filename}: ${warning}`);
          }
          if (excelFileBytes == null && isExcelFilename(filename)) {
            excelFileBytes = bytes;
          }
        } catch (err) {
          // Deterministic extraction failure — assembly turns it into the
          // inline note / single-file hard error.
          files.push({
            filename,
            mediaType,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const assembled = assembleSubmission(files);
      return {
        text: assembled.text,
        // Only meaningful when assembly confirmed a readable Excel attachment.
        excelFileBytes: assembled.excelFilename != null ? excelFileBytes : null,
        excelFilename: assembled.excelFilename,
        images: assembled.images,
        warnings: [...assembled.warnings, ...extractionWarnings],
      };
    }

    if (typeof submission.url === 'string' && submission.url.trim() !== '') {
      // URL submissions can't be fetched and rendered safely server-side;
      // grade the URL itself with a note (same behavior as the base app).
      return {
        text: `[Student submitted a URL: ${submission.url}]`,
        excelFileBytes: null,
        excelFilename: null,
        images: [],
        warnings: [],
      };
    }

    throw new Error('The submission has no gradable content (no file, text, or URL).');
  }

  // ------------------------------------------------------------ materials --

  /**
   * Loads the assignment's template/key materials as prompt inputs. Excel
   * keys against Excel submissions become a deterministic cell comparison;
   * everything else becomes extracted text. Material failures degrade to
   * "grade without that material" — never fail the whole grade over a
   * supplemental input.
   */
  private async loadMaterials(
    doc: GradingRunDocument,
    content: SubmissionContent,
  ): Promise<{ templateText: string | null; keyText: string | null; excelComparison: string | null }> {
    let templateText: string | null = null;
    let keyText: string | null = null;
    let excelComparison: string | null = null;

    try {
      const templateBytes = await this.deps.resources.downloadMaterial(
        doc.canvasCourseId,
        doc.canvasAssignmentId,
        'TEMPLATE',
        doc.canvasApiDomain,
      );
      if (templateBytes != null) {
        const entry = (await this.deps.resources.list(doc.canvasCourseId, doc.canvasApiDomain)).find(
          (r) => r.canvasAssignmentId === doc.canvasAssignmentId && r.kind === 'TEMPLATE',
        );
        templateText = (
          await extractSubmissionText(entry?.fileName ?? entry?.originalFilename, templateBytes, {
            mime: entry?.contentType,
          })
        ).text;
      }
    } catch (err) {
      this.warn(
        `[grader] Template material failed to load for assignment ${doc.canvasAssignmentId}; grading without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      const keyBytes = await this.deps.resources.downloadMaterial(
        doc.canvasCourseId,
        doc.canvasAssignmentId,
        'KEY',
        doc.canvasApiDomain,
      );
      if (keyBytes != null) {
        const entry = (await this.deps.resources.list(doc.canvasCourseId, doc.canvasApiDomain)).find(
          (r) => r.canvasAssignmentId === doc.canvasAssignmentId && r.kind === 'KEY',
        );
        // The submission side is already guaranteed by submission-assembly:
        // excelFileBytes is only ever set when isExcelFilename passed.
        const keyIsExcel = isExcelFilename(entry?.fileName ?? entry?.originalFilename);

        if (keyIsExcel && content.excelFileBytes != null) {
          // Deterministic comparison beats handing the model two flattened
          // spreadsheets and hoping it diffs them correctly.
          excelComparison = summarizeComparison(
            await compareToKey(content.excelFileBytes, Buffer.from(keyBytes)),
          );
        } else {
          keyText = (
            await extractSubmissionText(entry?.fileName ?? entry?.originalFilename, keyBytes, {
              mime: entry?.contentType,
            })
          ).text;
        }
      }
    } catch (err) {
      this.warn(
        `[grader] Key material failed to load for assignment ${doc.canvasAssignmentId}; grading without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return { templateText, keyText, excelComparison };
  }
}
