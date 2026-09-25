// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\WritebackService.cs
// (semantics from the TS predecessor's handleCanvasWriteback).
//
// Canvas writeback: posts an approved grade (score + prefixed comment +
// rubric assessment) to Canvas. Deliberately low-concurrency (the engine's
// writeback queue is 2 wide) — rate-limit-sensitive, and there is no hurry
// once a human has approved.
//
// THE HUMAN-IN-THE-LOOP CONTRACT: the faculty-trust prefix is applied HERE and
// only here, naming the person who APPROVED the row. Assignment comments are
// ADDITIVE in Canvas — a double post is a duplicate comment the teacher must
// hand-delete — so five layers guard against one:
//   1. PostedAt / status gate: a posted row never posts again.
//   2. In-flight claim: the same row can't post twice concurrently (two
//      writeback workers, approve followed by approve-all).
//   3. Local post ledger (~/.aigrader/ledger): a post that landed but whose
//      checkpoint never saved is recognized after a crash.
//   4. Pre-post Canvas check: if the exact prefixed comment is already on the
//      submission (posted from another laptop, or before a crash), the row is
//      marked POSTED instead of posting again.
//   5. Immediate checkpoint flush after every successful post.

import { audit } from '@aigrader/shared';
import type { GraderDraft, QuizDraft } from '@aigrader/shared';
import type { CanvasSubmission, PostGradeArgs } from '@aigrader/canvas';
import type { RunSession } from '../coordinator/run-session.js';
import { syncTotalPoints } from './rubric-draft-mapper.js';

/**
 * The faculty-trust indicator prefixed to EVERY AI-assisted comment. Policy,
 * not preference — this exact C# form is a parity contract: it tells students
 * which human reviewed and approved the grade.
 */
export const AI_ASSISTED_PREFIX_FORMAT = '[As Reviewed by {0}]';

/** string.Format(AiAssistedPrefixFormat, name) — the exact C# expansion. */
export function aiAssistedPrefix(facultyName: string): string {
  return AI_ASSISTED_PREFIX_FORMAT.replace('{0}', facultyName);
}

/** Prefix + optional body, exactly as the C# service composed it. */
export function prefixedComment(facultyName: string, feedback: string | null | undefined): string {
  const prefix = aiAssistedPrefix(facultyName);
  return feedback == null || feedback.trim() === '' ? prefix : `${prefix} ${feedback}`;
}

/** Failure message on a rejected assignment post (re-approve retries it). */
export const POST_FAILED_MESSAGE = 'Canvas rejected the grade post. Re-approve to try again.';
/** Failure message on a rejected quiz post. */
export const QUIZ_POST_FAILED_MESSAGE = 'Canvas rejected the quiz grade post. Re-approve to try again.';

// ------------------------------------------------------------------- ports --

export interface WritebackCanvasPort {
  postGrade(
    courseId: number,
    assignmentId: number,
    userId: number,
    args: PostGradeArgs,
  ): Promise<{ id: number | null; score: number | null; grade: string | null }>;
  postQuizQuestionGrades(
    courseId: number,
    quizId: number,
    quizSubmissionId: number,
    args: {
      attempt: number;
      questions: Record<string, { score?: number; comment?: string }>;
    },
  ): Promise<void>;
  /** For the pre-post duplicate check (include submission_comments). */
  getSubmission?(
    courseId: number,
    assignmentId: number,
    userId: number,
    opts?: { include?: readonly string[] },
  ): Promise<CanvasSubmission | null>;
}

/** Append-only record of successful posts (ids only), kept outside Canvas so a
 * post whose checkpoint never saved is still recognized after a crash. */
export interface PostLedgerPort {
  has(runId: string, key: string): boolean | Promise<boolean>;
  record(entry: { runId: string; key: string; postedAt: string }): void | Promise<void>;
}

export interface WritebackDeps {
  canvas: WritebackCanvasPort;
  ledger?: PostLedgerPort;
  auditFn?: typeof audit;
  warn?: (message: string) => void;
  now?: () => Date;
}

export interface WritebackItem {
  canvasUserId: number;
  /** Quiz attempt to post, grouping ALL its approved questions (quiz runs). */
  quizSubmissionId?: number;
}

/** Ledger key for an assignment row / a quiz attempt. */
export function ledgerKey(item: WritebackItem): string {
  return item.quizSubmissionId != null ? `q${item.quizSubmissionId}` : `u${item.canvasUserId}`;
}

// ---------------------------------------------------------------- service --

/** Posts approved grades back to Canvas; safe to call redundantly. */
export class WritebackService {
  private readonly canvas: WritebackCanvasPort;
  private readonly ledger?: PostLedgerPort;
  private readonly audit: typeof audit;
  private readonly warn: (message: string) => void;
  private readonly now: () => Date;
  /** Rows currently being posted (`${runId}:${ledgerKey}`). */
  private readonly inFlight = new Set<string>();

  constructor(deps: WritebackDeps) {
    this.canvas = deps.canvas;
    this.ledger = deps.ledger;
    this.audit = deps.auditFn ?? audit;
    this.warn = deps.warn ?? ((message) => console.warn(message));
    this.now = deps.now ?? (() => new Date());
  }

  /** Posts one approved grade (or one quiz attempt's approved questions). */
  async postOne(session: RunSession, item: WritebackItem): Promise<void> {
    const claim = `${session.document.runId}:${ledgerKey(item)}`;
    if (this.inFlight.has(claim)) return; // already being posted — never twice
    this.inFlight.add(claim);
    try {
      if (session.document.canvasQuizId != null) {
        await this.postQuizSubmission(session, item);
      } else {
        await this.postAssignmentGrade(session, item);
      }
    } finally {
      this.inFlight.delete(claim);
    }
  }

  private async postAssignmentGrade(session: RunSession, item: WritebackItem): Promise<void> {
    const doc = session.document;
    const grade = doc.grades.find((g) => g.canvasUserId === item.canvasUserId);
    if (!grade) return;

    // Gate 1: a grade with PostedAt set never posts again.
    if (grade.postedAt != null || grade.status !== 'APPROVED') return;

    // Faculty edits win over the AI draft — that's the whole review model.
    const draft: GraderDraft | null = grade.facultyEdited ?? grade.aiDraft;
    if (draft == null) {
      session.updateGrade(grade.canvasUserId, (g) => {
        g.status = 'ERROR';
        g.errorKind = 'grade';
        g.errorMessage = 'Approved with no draft to post.';
      });
      return;
    }

    // Last-line truth guard: the posted total must equal the criterion sum
    // the reviewer saw.
    syncTotalPoints(draft, doc.pointsPossible, doc.rubricSnapshot);

    const reviewer = grade.approvedBy?.name ?? doc.facultyName;
    const comment = prefixedComment(reviewer, draft.assignmentFeedback);

    // Gate 3: the local ledger says this post already landed.
    if (await this.ledgerHas(doc.runId, ledgerKey(item))) {
      await this.markAssignmentPosted(session, grade.canvasUserId, this.now().toISOString());
      return;
    }

    // Gate 4: the exact comment is already on the submission in Canvas.
    const existing = await this.findExistingComment(session, grade.canvasUserId, comment);
    if (existing) {
      await this.recordLedger(doc.runId, ledgerKey(item), existing);
      await this.markAssignmentPosted(session, grade.canvasUserId, existing);
      return;
    }

    const rubricAssessment =
      draft.rubrics.length > 0
        ? Object.fromEntries(
            draft.rubrics.map((r) => [
              r.criterionId,
              { points: r.points, comments: r.ratingFeedback },
            ]),
          )
        : null;

    try {
      await this.canvas.postGrade(doc.canvasCourseId, doc.canvasAssignmentId, grade.canvasUserId, {
        postedGrade: draft.totalPoints,
        comment,
        rubricAssessment,
      });
    } catch (err) {
      this.warn(
        `[writeback] Grade post failed for run ${doc.runId} user ${grade.canvasUserId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      session.updateGrade(grade.canvasUserId, (g) => {
        g.status = 'ERROR';
        g.errorKind = 'post';
        g.errorMessage = POST_FAILED_MESSAGE;
      });
      return;
    }

    const postedAt = this.now().toISOString();
    // Record BEFORE the checkpoint: the ledger is local and fast, so a crash
    // between the post and the Canvas flush still leaves proof of the post.
    await this.recordLedger(doc.runId, ledgerKey(item), postedAt);
    await this.markAssignmentPosted(session, grade.canvasUserId, postedAt);

    this.audit('GradePosted', {
      runId: doc.runId,
      canvasCourseId: doc.canvasCourseId,
      canvasAssignmentId: doc.canvasAssignmentId,
      canvasUserId: grade.canvasUserId,
      actorCanvasUserId: grade.approvedBy?.canvasUserId ?? doc.facultyCanvasUserId,
      approvalChannel: grade.approvedBy?.channel ?? null,
      reviewSeconds: grade.approvedBy?.reviewSeconds ?? null,
    });
  }

  private async markAssignmentPosted(
    session: RunSession,
    canvasUserId: number,
    postedAt: string,
  ): Promise<void> {
    session.updateGrade(canvasUserId, (g) => {
      g.status = 'POSTED';
      g.postedAt = postedAt;
      g.errorMessage = null;
      g.errorKind = undefined;
    });
    // Gate 5: flush immediately — PostedAt is the idempotency marker. A
    // failed flush stays dirty and retries (RunSession never drops it).
    try {
      await session.flush();
    } catch (err) {
      this.warn(
        `[writeback] Checkpoint after post failed for run ${session.document.runId}; will retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** The posted time of an identical comment already on the submission, or
   * null (also null when the check itself fails — the post then proceeds,
   * guarded by the other layers). */
  private async findExistingComment(
    session: RunSession,
    canvasUserId: number,
    comment: string,
  ): Promise<string | null> {
    if (!this.canvas.getSubmission) return null;
    const doc = session.document;
    try {
      const sub = await this.canvas.getSubmission(
        doc.canvasCourseId,
        doc.canvasAssignmentId,
        canvasUserId,
        { include: ['submission_comments'] },
      );
      const createdMs = Date.parse(doc.createdAt);
      const match = (sub?.submission_comments ?? []).find(
        (c) =>
          (c.comment ?? '').trim() === comment.trim() &&
          (c.created_at == null || !Number.isFinite(createdMs) || Date.parse(c.created_at) >= createdMs),
      );
      return match ? (match.created_at ?? this.now().toISOString()) : null;
    } catch (err) {
      this.warn(
        `[writeback] Pre-post comment check failed for run ${doc.runId} user ${canvasUserId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async ledgerHas(runId: string, key: string): Promise<boolean> {
    if (!this.ledger) return false;
    try {
      return await this.ledger.has(runId, key);
    } catch {
      return false;
    }
  }

  private async recordLedger(runId: string, key: string, postedAt: string): Promise<void> {
    if (!this.ledger) return;
    try {
      await this.ledger.record({ runId, key, postedAt });
    } catch (err) {
      this.warn(
        `[writeback] Post ledger write failed for run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Quiz path: gathers ALL approved questions for one quiz submission into a
   * single PUT (Canvas re-totals the quiz itself). Unlike assignment
   * comments, the quiz PUT is an idempotent OVERWRITE of the per-question
   * grade — a failure here is safe to retry by re-approving.
   */
  private async postQuizSubmission(session: RunSession, item: WritebackItem): Promise<void> {
    const doc = session.document;
    const quizSubmissionId = item.quizSubmissionId;
    if (quizSubmissionId == null) return;

    const questions = doc.quizGrades.filter(
      (q) =>
        q.quizSubmissionId === quizSubmissionId && q.status === 'APPROVED' && q.postedAt == null,
    );
    if (questions.length === 0) return;

    const grades: Record<string, { score?: number; comment?: string }> = {};
    for (const q of questions) {
      const draft: QuizDraft = q.facultyEdited ?? q.aiDraft ?? { score: 0, comment: '' };
      grades[String(q.questionId)] = {
        score: draft.score,
        comment: prefixedComment(q.approvedBy?.name ?? doc.facultyName, draft.comment),
      };
    }

    let ok = true;
    try {
      await this.canvas.postQuizQuestionGrades(doc.canvasCourseId, doc.canvasQuizId!, quizSubmissionId, {
        attempt: questions[0]!.attempt,
        questions: grades,
      });
    } catch (err) {
      ok = false;
      this.warn(
        `[writeback] Quiz writeback failed for submission ${quizSubmissionId} in run ${doc.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const postedAt = this.now().toISOString();
    for (const q of questions) {
      session.updateQuizGrade(q.quizSubmissionId, q.questionId, (g) => {
        if (ok) {
          g.status = 'POSTED';
          g.postedAt = postedAt;
          g.errorMessage = null;
          g.errorKind = undefined;
        } else {
          g.status = 'ERROR';
          g.errorKind = 'post';
          g.errorMessage = QUIZ_POST_FAILED_MESSAGE;
        }
      });
    }

    if (ok) {
      await this.recordLedger(doc.runId, ledgerKey(item), postedAt);
      try {
        await session.flush();
      } catch (err) {
        this.warn(
          `[writeback] Checkpoint after quiz post failed for run ${doc.runId}; will retry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.audit('QuizGradesPosted', {
        runId: doc.runId,
        canvasCourseId: doc.canvasCourseId,
        canvasQuizId: doc.canvasQuizId,
        questionCount: questions.length,
        actorCanvasUserId: questions[0]!.approvedBy?.canvasUserId ?? doc.facultyCanvasUserId,
        approvalChannel: questions[0]!.approvedBy?.channel ?? null,
      });
    }
  }
}
