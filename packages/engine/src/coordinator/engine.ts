// The run coordinator: StartRun fan-out, resume/reconcile, cancel, approve,
// and the two global work queues.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\GradingRunEngine.cs
// (fan-out + resume/reconcile), GradingChannels.cs / GradingEngineHostedService.cs
// (grade / writeback global consumers + phase transitions — channels become
// p-queues), plus the local progress-record mirror (progress-writer.ts).
//
// The queues are GLOBAL by design: simultaneous runs share one model/Canvas
// budget, exactly like the C# channels. On a teacher laptop the grade queue
// is small (each item is an isolated `codex exec`); Canvas rate limiting
// stays per-token via the gate registry.

import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import {
  GraderDraftSchema,
  GradingRunDocumentSchema,
  QuizDraftSchema,
  audit as sharedAudit,
  parseCourseKey,
  renderCourseProfileText,
} from '@aigrader/shared';
import type {
  EditSource,
  GradeStatus,
  GraderDraft,
  GradingRunDocument,
  QuizDraft,
  QuizQuestionGradeEntry,
  RubricCriterionSnapshot,
  RunProgressDoc,
  RunStatus,
  StudentGrade,
} from '@aigrader/shared';
import type {
  CanvasAssignment,
  CanvasRubricCriterion,
  CanvasSubmission,
  CourseUser,
  QuizQuestion,
  QuizSubmissionRef,
  RunListEntry,
} from '@aigrader/canvas';
import { hasFileAttachment, hasTextBody } from '@aigrader/canvas';
import type { GradingLlm } from '../llm/structured-client.js';
import { DiscussionAggregator } from '../grading/discussion-aggregator.js';
import { GraderAgent } from '../grading/grader-agent.js';
import type { GraderCanvasPort, ProfileStorePort, ResourceStorePort } from '../grading/grader-agent.js';
import { QuizGraderAgent } from '../grading/quiz-grader.js';
import type { QuizCanvasPort } from '../grading/quiz-grader.js';
import { WritebackService } from '../grading/writeback.js';
import type { PostLedgerPort, WritebackCanvasPort } from '../grading/writeback.js';
import { ProgressWriter, RUN_LOCK_STALE_S, deriveCounts } from '../progress/progress-writer.js';
import type { ProgressStorePort } from '../progress/progress-writer.js';
import {
  HEARTBEAT_FLUSH_MS,
  INSTANCE_ID,
  RowLockedError,
  RunSession,
  TERMINAL_RUN_STATUSES,
} from './run-session.js';
import type { LiveRun, RunRegistry } from './registry.js';
import type { PauseSignal } from './pause.js';

// ------------------------------------------------------------------- ports --

/** Everything the engine (and its agents) ask of Canvas — structural, so the
 * real CanvasClient satisfies it and tests pass plain objects. */
export interface EngineCanvasPort
  extends GraderCanvasPort,
    QuizCanvasPort,
    Omit<WritebackCanvasPort, 'getSubmission'> {
  getAssignment(courseId: number, assignmentId: number): Promise<CanvasAssignment>;
  getSubmissions(courseId: number, assignmentId: number): Promise<CanvasSubmission[]>;
  getCourseStudents(courseId: number): Promise<CourseUser[]>;
  getQuizQuestions(courseId: number, quizId: number): Promise<QuizQuestion[]>;
  getQuizSubmissions(courseId: number, quizId: number): Promise<QuizSubmissionRef[]>;
}

/** The RunStore surface the engine uses (the real RunStore satisfies it). */
export interface RunStorePort {
  saveRun(doc: GradingRunDocument): Promise<string>;
  loadRun(
    courseId: number,
    runId: string,
    apiDomain?: string | null,
  ): Promise<GradingRunDocument | null>;
  listRuns(courseId: number, apiDomain?: string | null): Promise<RunListEntry[]>;
  /** Retention sweep (finished/abandoned runs only). Best-effort; optional. */
  cleanup?(courseId: number, apiDomain?: string | null): Promise<void>;
}

/** How often one course's retention sweep may run from this process. */
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** One run's fully-derived Canvas surface (client + document stores), built
 * for the run's Canvas instance by the factory below. */
export interface RunClients {
  canvas: EngineCanvasPort;
  runStore: RunStorePort;
  profiles: ProfileStorePort;
  resources: ResourceStorePort;
}

/** Re-derives the Canvas clients for a run's instance (the course host).
 * EVERY entry point (start, resume, sweep, list) goes through this; the
 * teacher's token lives only in the credential provider behind it. */
export type RunClientFactory = (args: { apiDomain: string | null }) => Promise<RunClients>;

export interface EngineConfig {
  gradeConcurrency: number;
  writebackConcurrency: number;
  /** Model the grading backend should use ('' = the backend's default). */
  model: string;
  /** 'low' | 'medium' | 'high' ('' = the backend's default). */
  reasoningEffort: string;
  maxOutputTokens?: number;
}

/** Config from the local .env (AIGRADER_MAX_WORKERS=2 / writeback 2 defaults). */
export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return {
    gradeConcurrency: Number(env.AIGRADER_MAX_WORKERS ?? 2),
    writebackConcurrency: Number(env.AIGRADER_WRITEBACK_CONCURRENCY ?? 2),
    model: env.AIGRADER_MODEL ?? '',
    reasoningEffort: env.AIGRADER_REASONING_EFFORT ?? 'medium',
    maxOutputTokens: env.AIGRADER_MAX_OUTPUT_TOKENS
      ? Number(env.AIGRADER_MAX_OUTPUT_TOKENS)
      : undefined,
  };
}

/** Typed engine failure — routes map `code` onto HTTP statuses. */
export class EngineError extends Error {
  constructor(
    readonly code:
      | 'unknown_run'
      | 'run_not_resumable'
      | 'run_document_missing'
      | 'run_not_live'
      | 'unsupported_target'
      | 'quiz_has_no_essay_questions'
      | 'no_gradable_rows'
      | 'invalid_request'
      | 'row_locked'
      | 'run_already_active'
      | 'run_locked_elsewhere',
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface StartRunArgs {
  courseKey: string;
  /** Canvas host the run targets; defaults to the courseKey's host. */
  apiDomain?: string | null;
  faculty: { canvasUserId: number; name: string };
  target: {
    kind: 'assignment' | 'quiz' | 'discussion';
    assignmentId: number;
    quizId?: number;
    discussionId?: number;
  };
  instructions?: string | null;
  regradeAll?: boolean;
}

export type ResumeResult =
  | { outcome: 'already_live' }
  | { outcome: 'resumed'; requeued: number; writebacks: number }
  | { outcome: 'finalized_cancelled' }
  | { outcome: 'terminal' }
  | { outcome: 'skipped_lock' };

export interface ResumeOptions {
  /** Sweep posture: a fresh lock held by another process ⇒ 'skipped_lock'. */
  respectLock?: boolean;
  /** Interactive take-over of a run another laptop still holds a fresh lock
   * on. Without it, an interactive resume of such a run is refused
   * (run_locked_elsewhere) so two machines never drive one run. */
  takeOver?: boolean;
}

/** Who is approving (the browser-guarded approve route supplies it). */
export interface ApproverInput {
  canvasUserId: number;
  name: string;
}

/** Rows a re-run may target (assignment rows by user; quiz rows by pair). */
export interface RowTargets {
  userIds?: number[];
  quizItems?: Array<{ quizSubmissionId: number; questionId: number }>;
}

/** In-flight row statuses (a run with any of these is still drafting). */
const IN_FLIGHT: readonly GradeStatus[] = ['PENDING', 'EXTRACTING', 'SCORING'];

/**
 * The run status its rows imply. Computed from EVERY row, never from one
 * transition's point of view:
 *   - anything still drafting        → RUNNING
 *   - anything approved, not posted  → POSTING
 *   - every row posted               → COMPLETED
 *   - otherwise (drafts to review, or errors to re-run / re-approve) → REVIEWING
 */
export function phaseFor(rows: ReadonlyArray<{ status: GradeStatus; postedAt: string | null }>): RunStatus {
  if (rows.some((r) => IN_FLIGHT.includes(r.status))) return 'RUNNING';
  if (rows.some((r) => r.status === 'APPROVED' && r.postedAt == null)) return 'POSTING';
  if (rows.length > 0 && rows.every((r) => r.status === 'POSTED')) return 'COMPLETED';
  return 'REVIEWING';
}

interface GradeItem {
  canvasUserId: number;
  quizSubmissionId?: number;
  questionId?: number;
}

/** Everything the engine tracks per live run beyond the registry entry. */
interface RunContext {
  live: LiveRun;
  clients: RunClients;
  grader: GraderAgent;
  quizGrader: QuizGraderAgent;
  writeback: WritebackService;
}

export interface GradingEngineDeps {
  registry: RunRegistry;
  progressStore: ProgressStorePort;
  llm: Pick<GradingLlm, 'gradeSubmission' | 'gradeQuizQuestion'>;
  clients: RunClientFactory;
  config: EngineConfig;
  now?: () => Date;
  warn?: (message: string) => void;
  auditFn?: typeof sharedAudit;
  /** Run-id factory (tests). Default: GUID "N" format, as in C#. */
  newRunId?: () => string;
  /** Advisory-lock owner id for sessions this engine creates. */
  instanceId?: string;
  /** Local post ledger (writeback double-post defense). */
  ledger?: PostLedgerPort;
  /** Heartbeat-only checkpoint cadence while a run is open (0 disables). */
  heartbeatMs?: number;
  /** Stamped on every run document this engine creates. */
  generator?: string;
}

// ------------------------------------------------------------------ engine --

export class GradingEngine {
  private readonly deps: GradingEngineDeps;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly audit: typeof sharedAudit;
  private readonly instanceId: string;
  private readonly contexts = new Map<string, RunContext>();
  private readonly discussions = new DiscussionAggregator();
  /** Single-flight resumes: concurrent callers share one resume. */
  private readonly resuming = new Map<string, Promise<ResumeResult>>();
  /** courseKey → last retention sweep (ms). */
  private readonly lastCleanup = new Map<string, number>();
  /** Background housekeeping (awaited by onIdle). */
  private readonly background = new Set<Promise<void>>();
  /** Auto-unpause timers (usage-limit windows). */
  private readonly unpauseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Global work queues (grade 8 / writeback 2 — shared across runs). */
  readonly gradeQueue: PQueue;
  readonly writebackQueue: PQueue;

  constructor(deps: GradingEngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.warn = deps.warn ?? ((message) => console.warn(message));
    this.audit = deps.auditFn ?? sharedAudit;
    this.instanceId = deps.instanceId ?? INSTANCE_ID;
    this.gradeQueue = new PQueue({ concurrency: deps.config.gradeConcurrency });
    this.writebackQueue = new PQueue({ concurrency: deps.config.writebackConcurrency });
  }

  /** Both queues drained (tests / graceful checks). */
  async onIdle(): Promise<void> {
    await Promise.all([
      this.gradeQueue.onIdle(),
      this.writebackQueue.onIdle(),
      ...this.background,
    ]);
  }

  /**
   * What the local server's idle-shutdown and sleep-inhibit logic needs:
   *   busy    — grading or posting work is queued/in flight, or a live run is
   *             drafting/posting and not paused (keep the machine awake);
   *   waiting — a paused run will resume on its own (usage-limit window):
   *             stay running, but let the machine sleep;
   *   liveRuns — runs open in this process (any phase).
   */
  activity(): { busy: boolean; waiting: boolean; liveRuns: number } {
    const queued =
      this.gradeQueue.size +
      this.gradeQueue.pending +
      this.writebackQueue.size +
      this.writebackQueue.pending;
    let drafting = false;
    let waiting = false;
    for (const ctx of this.contexts.values()) {
      const status = ctx.live.session.document.status;
      if (ctx.live.paused) {
        if (ctx.live.paused.until) waiting = true;
        continue;
      }
      if (status === 'PENDING' || status === 'RUNNING' || status === 'POSTING') drafting = true;
    }
    return { busy: queued > 0 || drafting, waiting, liveRuns: this.contexts.size };
  }

  // ------------------------------------------------------------- start run --

  /**
   * Creates and starts a run: snapshots the assignment + rubric + roster into
   * the run document, fans out one row per gradable submission, seeds the
   * Canvas checkpoint, and enqueues grading. Returns the runId (grading
   * proceeds in the background queues).
   */
  async startRun(args: StartRunArgs): Promise<{ runId: string }> {
    const parsed = parseCourseKey(args.courseKey);
    const courseId = Number(parsed.courseId);
    const apiDomain = args.apiDomain ?? parsed.host;
    const runId = (this.deps.newRunId ?? (() => randomUUID().replaceAll('-', '')))();

    const clients = await this.deps.clients({ apiDomain });
    await this.assertNoActiveRun(clients, args.courseKey, courseId, apiDomain, args.target.assignmentId);
    const assignment = await clients.canvas.getAssignment(courseId, args.target.assignmentId);

    // Freeze the grading inputs: a prep or profile edit made while this run
    // drafts must not change later drafts (or a resume's).
    const [prep, profile] = await Promise.all([
      clients.resources.getPrep(courseId, args.target.assignmentId, apiDomain),
      clients.profiles.get(courseId, apiDomain),
    ]);

    // Snapshot everything the run needs up front — later edits to the
    // assignment/rubric in Canvas must not shift drafts mid-run.
    const nowIso = this.now().toISOString();
    const doc: GradingRunDocument = GradingRunDocumentSchema.parse({
      schemaVersion: 1,
      runId,
      canvasCourseId: courseId,
      canvasApiDomain: apiDomain,
      canvasAssignmentId: args.target.assignmentId,
      canvasQuizId: null,
      canvasDiscussionTopicId: null,
      assignmentName: assignment.name ?? `Assignment ${args.target.assignmentId}`,
      pointsPossible: assignment.points_possible,
      assignmentDescriptionHtml: assignment.description ?? null,
      rubricSnapshot: toRubricSnapshot(assignment.rubric ?? []),
      modelName: this.deps.config.model,
      reasoningEffort: this.deps.config.reasoningEffort,
      additionalInstructions: args.instructions ?? null,
      facultyCanvasUserId: args.faculty.canvasUserId,
      facultyName: args.faculty.name,
      status: 'PENDING',
      createdAt: nowIso,
      updatedAt: nowIso,
      prepSnapshot: {
        customInstructions: prep.customInstructions ?? '',
        shareRubric: prep.shareRubric !== false,
        shareInstructions: prep.shareInstructions !== false,
        profileText: renderCourseProfileText(profile),
      },
      ...(this.deps.generator ? { generator: this.deps.generator } : {}),
    });

    // Roster for id → display-name mapping (the run doc stores names so the
    // review UI works without a roster fetch).
    const students = await clients.canvas.getCourseStudents(courseId);
    const names = new Map(students.map((s) => [s.id, s.name ?? `Student ${s.id}`]));

    let rows: StudentGrade[] = [];
    let quizRows: QuizQuestionGradeEntry[] = [];
    let items: GradeItem[];

    if (args.target.kind === 'quiz') {
      const quizId = args.target.quizId ?? assignment.quiz_id;
      if (quizId == null) {
        throw new EngineError('unsupported_target', 'Quiz target has no quiz id.');
      }
      doc.canvasQuizId = quizId;
      const fanned = await this.fanOutQuiz(clients, doc, names);
      quizRows = fanned.rows;
      items = quizRows.map((r) => ({
        canvasUserId: r.canvasUserId,
        quizSubmissionId: r.quizSubmissionId,
        questionId: r.questionId,
      }));
    } else if (args.target.kind === 'discussion') {
      const topicId = args.target.discussionId ?? assignment.discussion_topic?.id;
      if (topicId == null) {
        throw new EngineError('unsupported_target', 'Discussion assignment has no topic id.');
      }
      doc.canvasDiscussionTopicId = topicId;
      rows = await this.fanOutDiscussion(clients, doc, names, args.regradeAll === true);
      items = rows.map((r) => ({ canvasUserId: r.canvasUserId }));
    } else {
      rows = await this.fanOutAssignment(clients, doc, names, args.regradeAll === true);
      items = rows.map((r) => ({ canvasUserId: r.canvasUserId }));
    }

    if (items.length === 0) {
      throw new EngineError(
        'no_gradable_rows',
        'Nothing to grade: no gradable submissions matched the run filters.',
      );
    }

    const ctx = this.register(doc, clients, {
      courseKey: args.courseKey,
      apiDomain,
      resumeCount: 0,
      cancelRequested: false,
    });
    if (doc.canvasQuizId != null) ctx.live.session.setQuizGrades(quizRows);
    else ctx.live.session.setGrades(rows);

    // Seed checkpoint (immediate flush) + first progress write.
    await ctx.live.session.transition('RUNNING');
    await ctx.live.progress.writeNow();

    this.enqueueGradeItems(ctx, items);

    this.audit('RunCreated', {
      runId,
      canvasCourseId: courseId,
      canvasAssignmentId: doc.canvasAssignmentId,
      canvasQuizId: doc.canvasQuizId,
      canvasDiscussionTopicId: doc.canvasDiscussionTopicId,
      apiDomain: apiDomain ?? 'default',
      totalCount: doc.totalCount,
      modelName: doc.modelName,
      actorCanvasUserId: args.faculty.canvasUserId,
    });
    return { runId };
  }

  /** Regular-assignment fan-out: one row per gradable submission (port of
   * workers\grading.ts via GradingRunEngine.StartAssignmentFanOutAsync). */
  private async fanOutAssignment(
    clients: RunClients,
    doc: GradingRunDocument,
    names: Map<number, string>,
    regradeAll: boolean,
  ): Promise<StudentGrade[]> {
    const submissions = await clients.canvas.getSubmissions(
      doc.canvasCourseId,
      doc.canvasAssignmentId,
    );
    const nowIso = this.now().toISOString();
    return submissions
      .filter((s) =>
        ['submitted', 'graded', 'pending_review'].includes(s.workflow_state ?? ''),
      )
      .filter(
        (s) => hasFileAttachment(s) || hasTextBody(s) || (s.url ?? '').trim() !== '',
      )
      .filter((s) => regradeAll || s.workflow_state !== 'graded')
      .map((s) => ({
        canvasUserId: s.user_id,
        studentName: names.get(s.user_id) ?? `Student ${s.user_id}`,
        submissionType: s.submission_type ?? null,
        attachmentMime: s.attachments?.[0]?.['content-type'] ?? null,
        attachmentCount: s.attachments?.length ?? 0,
        extractionWarnings: [],
        submittedAt: s.submitted_at ?? null,
        status: 'PENDING' as const,
        submissionExcerpt: null,
        excerptTruncated: false,
        aiDraft: null,
        facultyEdited: null,
        llm: null,
        errorMessage: null,
        postedAt: null,
        updatedAt: nowIso,
      }));
  }

  /** Graded-discussion fan-out: one row per STUDENT WHO POSTED (roster-
   * intersected so instructor posts don't become gradable rows). */
  private async fanOutDiscussion(
    clients: RunClients,
    doc: GradingRunDocument,
    names: Map<number, string>,
    regradeAll: boolean,
  ): Promise<StudentGrade[]> {
    const posts = await this.discussions.getStudentTexts(
      clients.canvas,
      doc.canvasCourseId,
      doc.canvasDiscussionTopicId!,
      doc.canvasApiDomain,
    );

    // Already-graded filter still comes from the gradebook submissions.
    const submissions = await clients.canvas.getSubmissions(
      doc.canvasCourseId,
      doc.canvasAssignmentId,
    );
    const gradedUsers = new Set(
      submissions.filter((s) => s.workflow_state === 'graded').map((s) => s.user_id),
    );

    const nowIso = this.now().toISOString();
    return [...posts.keys()]
      .filter((userId) => names.has(userId)) // students only
      .filter((userId) => regradeAll || !gradedUsers.has(userId))
      .map((userId) => ({
        canvasUserId: userId,
        studentName: names.get(userId)!,
        submissionType: 'discussion_topic',
        attachmentMime: null,
        attachmentCount: 0,
        extractionWarnings: [],
        submittedAt: null,
        status: 'PENDING' as const,
        submissionExcerpt: null,
        excerptTruncated: false,
        aiDraft: null,
        facultyEdited: null,
        llm: null,
        errorMessage: null,
        postedAt: null,
        updatedAt: nowIso,
      }));
  }

  /** Quiz fan-out: essay questions only, taken attempts only, one row per
   * (attempt × question). Port of the TS fanOutQuizRun via C#. */
  private async fanOutQuiz(
    clients: RunClients,
    doc: GradingRunDocument,
    names: Map<number, string>,
  ): Promise<{ rows: QuizQuestionGradeEntry[]; attemptCount: number }> {
    const quizId = doc.canvasQuizId!;
    const questions = (
      await clients.canvas.getQuizQuestions(doc.canvasCourseId, quizId)
    ).filter((q) => q.question_type === 'essay_question');
    if (questions.length === 0) {
      throw new EngineError(
        'quiz_has_no_essay_questions',
        'This quiz has no essay questions — everything else is auto-graded by Canvas.',
      );
    }

    const questionName = (q: QuizQuestion, i: number): string =>
      q.question_name == null || q.question_name.trim() === ''
        ? `Question ${q.position ?? i + 1}`
        : q.question_name;

    doc.quizQuestionSnapshot = questions.map((q, i) => ({
      questionId: q.id,
      questionName: questionName(q, i),
      questionTextHtml: q.question_text ?? '',
      maxPoints: q.points_possible ?? 0,
      correctComments: q.correct_comments ?? null,
      neutralComments: q.neutral_comments ?? null,
    }));

    const attempts = (await clients.canvas.getQuizSubmissions(doc.canvasCourseId, quizId))
      .filter((s) => ['complete', 'pending_review'].includes(s.workflow_state ?? ''))
      .filter((s) => s.attempt != null) // the grading PUT requires an attempt number
      .filter((s) => s.user_id != null);

    const nowIso = this.now().toISOString();
    const rows = attempts.flatMap((attempt) =>
      questions.map((q, i) => ({
        canvasUserId: attempt.user_id!,
        studentName: names.get(attempt.user_id!) ?? `Student ${attempt.user_id}`,
        quizSubmissionId: attempt.id,
        attempt: attempt.attempt!,
        questionId: q.id,
        questionName: questionName(q, i),
        maxPoints: q.points_possible ?? 0,
        status: 'PENDING' as const,
        answerExcerpt: null,
        aiDraft: null,
        facultyEdited: null,
        errorMessage: null,
        postedAt: null,
        updatedAt: nowIso,
      })),
    );
    return { rows, attemptCount: attempts.length };
  }

  // ---------------------------------------------------------------- resume --

  /**
   * Resumes a checkpointed run after a crash/restart: reconciles each row
   * against Canvas reality, then re-queues unfinished work.
   *
   * Reconciliation rules (ported from GradingRunEngine.ResumeRunAsync):
   *  - EXTRACTING/SCORING rows were in flight — reset to PENDING and re-queue
   *    (drafts are cheap; re-grading is safe).
   *  - APPROVED rows without PostedAt: Canvas score match + graded_at newer
   *    than the checkpoint's last write ⇒ the post landed before the crash —
   *    mark POSTED, never re-post; otherwise re-queue the writeback.
   *  - POSTED rows are never touched.
   *  - Rows whose Canvas submitted_at is newer than the graded submission are
   *    flagged via errorMessage ("resubmitted") so the reviewer sees it.
   */
  async resume(runId: string, opts: ResumeOptions = {}): Promise<ResumeResult> {
    // A live but PAUSED run: resuming lifts the pause and re-queues its rows.
    const live = this.contexts.get(runId);
    if (live) {
      if (live.live.paused) return this.unpause(runId);
      return { outcome: 'already_live' };
    }
    // Single flight: two requests racing to revive the same run share one
    // resume (a second registry.create would throw "already registered").
    const inFlight = this.resuming.get(runId);
    if (inFlight) return inFlight;
    const work = this.resumeInner(runId, opts).finally(() => {
      this.resuming.delete(runId);
    });
    this.resuming.set(runId, work);
    return work;
  }

  private async resumeInner(runId: string, opts: ResumeOptions): Promise<ResumeResult> {
    if (this.deps.registry.get(runId)) return { outcome: 'already_live' };

    const progress = await this.deps.progressStore.get(runId);
    if (!progress) throw new EngineError('unknown_run', `No progress record for run ${runId}.`);

    const clients = await this.deps.clients({ apiDomain: progress.apiDomain });
    const doc = await clients.runStore.loadRun(progress.canvasCourseId, runId, progress.apiDomain);
    if (!doc) {
      throw new EngineError(
        'run_document_missing',
        `Run ${runId} has no checkpoint document in Canvas.`,
      );
    }

    // Advisory-lock respect: a FRESH heartbeat from another owner means the
    // run is open on another computer. The sweep leaves it alone; an
    // interactive resume refuses unless the teacher explicitly takes over.
    if (doc.lock && doc.lock.owner && doc.lock.owner !== this.instanceId && !opts.takeOver) {
      const heartbeatMs = Date.parse(doc.lock.heartbeatUtc);
      if (
        Number.isFinite(heartbeatMs) &&
        this.now().getTime() - heartbeatMs < RUN_LOCK_STALE_S * 1000
      ) {
        if (opts.respectLock) return { outcome: 'skipped_lock' };
        throw new EngineError(
          'run_locked_elsewhere',
          `This run is open on another computer${
            doc.lock.ownerName ? ` (${doc.lock.ownerName})` : ''
          }. Take it over only if that computer is no longer grading it.`,
        );
      }
    }

    const ctx = this.register(doc, clients, {
      courseKey: progress.courseKey,
      apiDomain: progress.apiDomain,
      resumeCount: progress.worker.resumeCount + 1,
      cancelRequested: progress.cancelRequested,
    });

    // Already terminal (crash between terminal flush and progress write):
    // just finish the bookkeeping.
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(doc.status)) {
      await this.finalizeTerminal(runId);
      return { outcome: 'terminal' };
    }

    // Cancel requested while the owner was dead: finalize CANCELLED without
    // re-queuing anything (never touches POSTED rows).
    if (progress.cancelRequested) {
      ctx.live.cancelRequested = true;
      ctx.live.controller.abort();
      await ctx.live.session.transition('CANCELLED');
      await this.finalizeTerminal(runId);
      return { outcome: 'finalized_cancelled' };
    }

    // A usage-limit pause that hasn't lifted yet stays paused (the timer
    // resumes it); nothing is re-queued until then.
    if (
      doc.pausedReason === 'usage_limit' &&
      doc.pausedUntil != null &&
      Date.parse(doc.pausedUntil) > this.now().getTime()
    ) {
      ctx.live.paused = {
        reason: 'usage_limit',
        until: doc.pausedUntil,
        message: doc.pausedMessage ?? 'Your Codex usage limit was reached.',
      };
      this.scheduleUnpause(runId, doc.pausedUntil);
      return { outcome: 'resumed', requeued: 0, writebacks: 0 };
    }
    this.clearPauseFields(doc);

    const result =
      doc.canvasQuizId != null
        ? await this.reconcileQuizRun(ctx)
        : await this.reconcileAssignmentRun(ctx);

    this.audit('RunResumed', {
      runId,
      canvasCourseId: doc.canvasCourseId,
      resumeCount: progress.worker.resumeCount + 1,
      actorCanvasUserId: doc.facultyCanvasUserId,
    });
    return { outcome: 'resumed', ...result };
  }

  private async reconcileAssignmentRun(
    ctx: RunContext,
  ): Promise<{ requeued: number; writebacks: number }> {
    const session = ctx.live.session;
    const doc = session.document;
    // Capture before any mutation — flushes rewrite doc.updatedAt.
    const checkpointUpdatedAtMs = Date.parse(doc.updatedAt);

    const submissions = await ctx.clients.canvas.getSubmissions(
      doc.canvasCourseId,
      doc.canvasAssignmentId,
    );
    const byUser = new Map(submissions.map((s) => [s.user_id, s]));

    const toRequeue: number[] = [];
    const toWriteback: number[] = [];

    for (const grade of doc.grades) {
      const sub = byUser.get(grade.canvasUserId);

      switch (grade.status) {
        case 'EXTRACTING':
        case 'SCORING':
          session.updateGrade(grade.canvasUserId, (g) => {
            g.status = 'PENDING';
          });
          toRequeue.push(grade.canvasUserId);
          break;

        case 'PENDING':
          toRequeue.push(grade.canvasUserId);
          break;

        case 'APPROVED': {
          if (grade.postedAt != null) break;
          // Did the crash interrupt POSTING after Canvas accepted it? Score
          // match + a grade timestamp later than our last write means it
          // landed; trust Canvas and skip the re-post.
          const draft = grade.facultyEdited ?? grade.aiDraft;
          const draftScore = draft ? scoreOf(draft) : null;
          const gradedAtMs = sub?.graded_at != null ? Date.parse(sub.graded_at) : Number.NaN;
          if (
            sub?.score != null &&
            draftScore != null &&
            Math.abs(sub.score - draftScore) < 0.001 &&
            Number.isFinite(gradedAtMs) &&
            gradedAtMs >= checkpointUpdatedAtMs - 5 * 60 * 1000
          ) {
            session.updateGrade(grade.canvasUserId, (g) => {
              g.status = 'POSTED';
              g.postedAt = new Date(gradedAtMs).toISOString();
            });
          } else {
            toWriteback.push(grade.canvasUserId);
          }
          break;
        }

        default:
          break;
      }

      // Resubmission flag, independent of status.
      if (
        sub?.submitted_at != null &&
        grade.submittedAt != null &&
        Date.parse(sub.submitted_at) > Date.parse(grade.submittedAt) + 1000 &&
        ['DRAFT', 'EDITED', 'APPROVED', 'POSTED'].includes(grade.status)
      ) {
        session.updateGrade(grade.canvasUserId, (g) => {
          g.errorMessage = 'Student resubmitted after this draft was graded — consider re-running.';
        });
      }
    }

    // Every row decides the phase — a resumed POSTING run whose posts all
    // landed completes here instead of stalling in REVIEWING.
    await this.checkRunPhase(ctx);
    if (this.contexts.has(doc.runId)) await ctx.live.progress.writeNow();

    this.enqueueGradeItems(ctx, toRequeue.map((canvasUserId) => ({ canvasUserId })));
    for (const canvasUserId of toWriteback) {
      this.enqueueWriteback(ctx, { canvasUserId });
    }
    return { requeued: toRequeue.length, writebacks: toWriteback.length };
  }

  /** Quiz-run resume: simpler — the quiz grading PUT is an idempotent
   * overwrite, so no Canvas-side reconciliation is needed. */
  private async reconcileQuizRun(
    ctx: RunContext,
  ): Promise<{ requeued: number; writebacks: number }> {
    const session = ctx.live.session;
    const doc = session.document;

    const toRequeue: GradeItem[] = [];
    const writebackSubmissions = new Map<number, number>(); // qsid → canvasUserId

    for (const grade of doc.quizGrades) {
      switch (grade.status) {
        case 'EXTRACTING':
        case 'SCORING':
          session.updateQuizGrade(grade.quizSubmissionId, grade.questionId, (g) => {
            g.status = 'PENDING';
          });
          toRequeue.push({
            canvasUserId: grade.canvasUserId,
            quizSubmissionId: grade.quizSubmissionId,
            questionId: grade.questionId,
          });
          break;
        case 'PENDING':
          toRequeue.push({
            canvasUserId: grade.canvasUserId,
            quizSubmissionId: grade.quizSubmissionId,
            questionId: grade.questionId,
          });
          break;
        case 'APPROVED':
          if (grade.postedAt == null) {
            writebackSubmissions.set(grade.quizSubmissionId, grade.canvasUserId);
          }
          break;
        default:
          break;
      }
    }

    // Every row decides the phase — a resumed POSTING run whose posts all
    // landed completes here instead of stalling in REVIEWING.
    await this.checkRunPhase(ctx);
    if (this.contexts.has(doc.runId)) await ctx.live.progress.writeNow();

    this.enqueueGradeItems(ctx, toRequeue);
    for (const [quizSubmissionId, canvasUserId] of writebackSubmissions) {
      this.enqueueWriteback(ctx, { canvasUserId, quizSubmissionId });
    }
    return { requeued: toRequeue.length, writebacks: writebackSubmissions.size };
  }

  // ---------------------------------------------------------------- cancel --

  /**
   * Cancels a run: flags the progress record + in-memory state, aborts
   * in-flight LLM calls, and transitions CANCELLED with an immediate flush.
   * NEVER touches POSTED rows. When the run isn't live in this process, the
   * flag alone is set and the resume sweep finalizes it.
   */
  async cancel(runId: string): Promise<{ status: 'cancelled' | 'flagged' }> {
    const live = this.deps.registry.get(runId);
    if (!live) {
      const progress = await this.deps.progressStore.get(runId);
      if (!progress) throw new EngineError('unknown_run', `No progress record for run ${runId}.`);
      await this.deps.progressStore.requestCancel(runId);
      return { status: 'flagged' };
    }

    live.cancelRequested = true;
    live.progress.setCancelRequested(true);
    live.controller.abort();
    await this.deps.progressStore.requestCancel(runId);
    await live.session.transition('CANCELLED'); // immediate flush
    await this.finalizeTerminal(runId);
    return { status: 'cancelled' };
  }

  // --------------------------------------------------------- edit / approve --

  /** Records a faculty edit on the live session (~3s flush tier). Only
   * DRAFT/EDITED rows are editable — an approved grade is locked. */
  async edit(
    runId: string,
    args: {
      canvasUserId: number;
      facultyEdited: unknown;
      quizSubmissionId?: number;
      questionId?: number;
      source?: EditSource;
    },
  ): Promise<void> {
    const ctx = await this.requireLive(runId);
    const doc = ctx.live.session.document;
    try {
      if (doc.canvasQuizId != null) {
        if (args.quizSubmissionId == null || args.questionId == null) {
          throw new EngineError(
            'invalid_request',
            'Quiz edits require quizSubmissionId and questionId.',
          );
        }
        const edited: QuizDraft = QuizDraftSchema.parse(args.facultyEdited);
        ctx.live.session.saveQuizFacultyEdit(
          args.quizSubmissionId,
          args.questionId,
          edited,
          args.source ?? 'browser',
        );
      } else {
        const edited: GraderDraft = GraderDraftSchema.parse(args.facultyEdited);
        ctx.live.session.saveFacultyEdit(args.canvasUserId, edited, args.source ?? 'browser');
      }
    } catch (err) {
      if (err instanceof RowLockedError) throw new EngineError('row_locked', err.message);
      throw err;
    }
  }

  /**
   * Discards a faculty edit ("revert to AI"): the row goes back to its AI
   * draft (DRAFT). Only DRAFT/EDITED rows.
   */
  async revert(
    runId: string,
    args: { canvasUserId: number; quizSubmissionId?: number; questionId?: number },
  ): Promise<void> {
    const ctx = await this.requireLive(runId);
    const session = ctx.live.session;
    const doc = session.document;
    const clear = (row: { status: GradeStatus; facultyEdited: unknown; editSource?: EditSource; staleEdit?: boolean }) => {
      if (row.status !== 'DRAFT' && row.status !== 'EDITED') {
        throw new EngineError('row_locked', 'Only drafts can be reverted to the AI version.');
      }
    };
    if (doc.canvasQuizId != null) {
      const row = doc.quizGrades.find(
        (g) => g.quizSubmissionId === args.quizSubmissionId && g.questionId === args.questionId,
      );
      if (!row) throw new EngineError('invalid_request', 'No such quiz row.');
      clear(row);
      session.updateQuizGrade(row.quizSubmissionId, row.questionId, (g) => {
        g.facultyEdited = null;
        g.editSource = undefined;
        g.staleEdit = undefined;
        g.status = 'DRAFT';
      });
    } else {
      const row = doc.grades.find((g) => g.canvasUserId === args.canvasUserId);
      if (!row) throw new EngineError('invalid_request', 'No such student row.');
      clear(row);
      session.updateGrade(row.canvasUserId, (g) => {
        g.facultyEdited = null;
        g.editSource = undefined;
        g.staleEdit = undefined;
        g.status = 'DRAFT';
      });
    }
    await session.flush();
  }

  /**
   * Re-grades rows (grading only — nothing posts). Targets ERROR, DRAFT, and
   * EDITED rows (e.g. a failed extraction, or a student who resubmitted);
   * APPROVED/POSTED/in-flight rows are left alone. A kept faculty edit is
   * flagged stale when the new AI draft arrives. Returns the count re-queued.
   */
  async rerun(runId: string, targets: RowTargets): Promise<{ requeued: number }> {
    const ctx = await this.requireLive(runId);
    const session = ctx.live.session;
    const doc = session.document;
    const rerunnable: readonly GradeStatus[] = ['ERROR', 'DRAFT', 'EDITED'];
    const items: GradeItem[] = [];

    if (doc.canvasQuizId != null) {
      const wanted = new Set((targets.quizItems ?? []).map((t) => `${t.quizSubmissionId}:${t.questionId}`));
      const byUser = new Set(targets.userIds ?? []);
      for (const g of doc.quizGrades) {
        const hit = wanted.has(`${g.quizSubmissionId}:${g.questionId}`) || byUser.has(g.canvasUserId);
        if (!hit || !rerunnable.includes(g.status)) continue;
        session.updateQuizGrade(g.quizSubmissionId, g.questionId, (row) => {
          row.status = 'PENDING';
          row.errorMessage = null;
          row.errorKind = undefined;
        });
        items.push({
          canvasUserId: g.canvasUserId,
          quizSubmissionId: g.quizSubmissionId,
          questionId: g.questionId,
        });
      }
    } else {
      const wanted = new Set(targets.userIds ?? []);
      for (const g of doc.grades) {
        if (!wanted.has(g.canvasUserId) || !rerunnable.includes(g.status)) continue;
        session.updateGrade(g.canvasUserId, (row) => {
          row.status = 'PENDING';
          row.errorMessage = null;
          row.errorKind = undefined;
        });
        items.push({ canvasUserId: g.canvasUserId });
      }
    }

    if (items.length > 0) {
      await this.checkRunPhase(ctx); // → RUNNING
      await ctx.live.progress.writeNow();
      this.enqueueGradeItems(ctx, items);
    }
    return { requeued: items.length };
  }

  /**
   * Approves rows (DRAFT/EDITED → APPROVED) and enqueues their writeback.
   * The human-in-the-loop gate: NOTHING posts to
   * Canvas except through here.
   */
  async approve(
    runId: string,
    opts: {
      userIds?: number[];
      all?: boolean;
      approver: ApproverInput;
      /** Seconds the reviewer spent per student (audit), when known. */
      reviewSeconds?: Record<string, number>;
    },
  ): Promise<{ approved: number }> {
    if (!opts.all && (!opts.userIds || opts.userIds.length === 0)) {
      throw new EngineError('invalid_request', 'approve requires userIds or all:true.');
    }
    const ctx = await this.requireLive(runId);
    const session = ctx.live.session;
    const doc = session.document;
    const wanted = (userId: number) => opts.all === true || opts.userIds!.includes(userId);
    const approvedAt = this.now().toISOString();
    const approvedBy = (userId: number) => {
      const seconds = opts.reviewSeconds?.[String(userId)];
      return {
        canvasUserId: opts.approver.canvasUserId,
        name: opts.approver.name,
        approvedAt,
        channel: 'browser' as const,
        ...(typeof seconds === 'number' && seconds >= 0 ? { reviewSeconds: Math.round(seconds) } : {}),
      };
    };
    // Approvable: a draft (DRAFT/EDITED), or a row whose POST failed (its
    // draft is intact — re-approving retries the post without re-grading).
    const approvable = (g: {
      status: GradeStatus;
      postedAt: string | null;
      errorKind?: string;
      aiDraft: unknown;
      facultyEdited: unknown;
    }) =>
      g.postedAt == null &&
      (g.status === 'DRAFT' ||
        g.status === 'EDITED' ||
        (g.status === 'ERROR' && g.errorKind === 'post' && (g.facultyEdited ?? g.aiDraft) != null));

    let approved = 0;
    const writebacks: Array<{ canvasUserId: number; quizSubmissionId?: number }> = [];
    if (doc.canvasQuizId != null) {
      const targets = doc.quizGrades.filter((g) => wanted(g.canvasUserId) && approvable(g));
      const bySubmission = new Map<number, number>();
      for (const g of targets) {
        session.updateQuizGrade(g.quizSubmissionId, g.questionId, (row) => {
          row.status = 'APPROVED';
          row.approvedBy = approvedBy(g.canvasUserId);
          row.errorMessage = null;
          row.errorKind = undefined;
        });
        bySubmission.set(g.quizSubmissionId, g.canvasUserId);
        approved++;
      }
      for (const [quizSubmissionId, canvasUserId] of bySubmission) {
        writebacks.push({ canvasUserId, quizSubmissionId });
      }
    } else {
      const targets = doc.grades.filter((g) => wanted(g.canvasUserId) && approvable(g));
      for (const g of targets) {
        session.updateGrade(g.canvasUserId, (row) => {
          row.status = 'APPROVED';
          row.approvedBy = approvedBy(g.canvasUserId);
          row.errorMessage = null;
          row.errorKind = undefined;
        });
        writebacks.push({ canvasUserId: g.canvasUserId });
        approved++;
      }
    }
    if (approved > 0) {
      // Approvals are durable before anything posts; the phase follows every
      // row (approving while others still draft keeps the run RUNNING).
      await this.checkRunPhase(ctx);
      await session.flush();
      await ctx.live.progress.writeNow();
      for (const item of writebacks) this.enqueueWriteback(ctx, item);
    }
    return { approved };
  }

  // ------------------------------------------------------- snapshot / list --

  /** The run document: live session first, else the Canvas checkpoint. */
  async getSnapshot(runId: string): Promise<GradingRunDocument> {
    const live = this.deps.registry.get(runId);
    if (live) return live.session.document;

    const progress = await this.deps.progressStore.get(runId);
    if (!progress) {
      throw new EngineError('unknown_run', `No progress record for run ${runId}.`);
    }
    const clients = await this.deps.clients({ apiDomain: progress.apiDomain });
    const doc = await clients.runStore.loadRun(progress.canvasCourseId, runId, progress.apiDomain);
    if (!doc) {
      throw new EngineError('run_document_missing', `Run ${runId} has no checkpoint document.`);
    }
    return doc;
  }

  /**
   * Makes a run this process never started (another laptop's, or one the C#
   * app wrote) known locally: loads its Canvas checkpoint for the given
   * course and records an ADOPTED progress record, so snapshot/resume/edit
   * work on it. Adopted records are never auto-resumed by the sweep and never
   * persisted — taking over a run is an explicit resume. Returns the record;
   * throws unknown_run when the course has no such run (a runId from another
   * course never resolves).
   */
  async adopt(runId: string, courseKey: string): Promise<RunProgressDoc> {
    const existing = await this.deps.progressStore.get(runId);
    if (existing) {
      if (existing.courseKey !== courseKey) {
        throw new EngineError('unknown_run', `No run ${runId} in this course.`);
      }
      return existing;
    }
    const parsed = parseCourseKey(courseKey);
    const courseId = Number(parsed.courseId);
    const clients = await this.deps.clients({ apiDomain: parsed.host });
    const doc = await clients.runStore.loadRun(courseId, runId, parsed.host);
    if (!doc) throw new EngineError('unknown_run', `No run ${runId} in this course.`);
    const record: RunProgressDoc = {
      runId,
      canvasCourseId: doc.canvasCourseId,
      canvasAssignmentId: doc.canvasAssignmentId,
      apiDomain: parsed.host,
      courseKey,
      status: doc.status,
      counts: deriveCounts(doc),
      cancelRequested: false,
      worker: {
        owner: doc.lock?.owner ?? '',
        heartbeatAt: doc.lock?.heartbeatUtc ?? null,
        resumeCount: 0,
      },
      checkpoint: { lastSavedAt: doc.updatedAt },
      createdAt: doc.createdAt,
      updatedAt: this.now().toISOString(),
      adopted: true,
    };
    await this.deps.progressStore.set(runId, record);
    return record;
  }

  /** The run's progress record: the live writer's snapshot when the run is
   * live here, else the stored local record. */
  async getProgress(runId: string): Promise<RunProgressDoc> {
    const live = this.deps.registry.get(runId);
    if (live) return live.progress.snapshot();
    const stored = await this.deps.progressStore.get(runId);
    if (!stored) throw new EngineError('unknown_run', `No progress record for run ${runId}.`);
    return stored;
  }

  /** Lists a course's runs from the Canvas runs folder (filename metadata
   * only — no document downloads). */
  async listRuns(args: { courseKey: string; assignmentId?: number }): Promise<RunListEntry[]> {
    const parsed = parseCourseKey(args.courseKey);
    const clients = await this.deps.clients({ apiDomain: parsed.host });
    const courseId = Number(parsed.courseId);
    const entries = await clients.runStore.listRuns(courseId, parsed.host);
    this.maybeCleanup(args.courseKey, clients, courseId, parsed.host);
    return args.assignmentId != null
      ? entries.filter((e) => e.canvasAssignmentId === args.assignmentId)
      : entries;
  }

  // ------------------------------------------------------------- internals --

  /** Fires the course's retention sweep in the background, at most once per
   * CLEANUP_INTERVAL_MS per course. */
  private maybeCleanup(
    courseKey: string,
    clients: RunClients,
    courseId: number,
    apiDomain: string,
  ): void {
    if (!clients.runStore.cleanup) return;
    const nowMs = this.now().getTime();
    const last = this.lastCleanup.get(courseKey);
    if (last != null && nowMs - last < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup.set(courseKey, nowMs);
    const work: Promise<void> = clients.runStore.cleanup(courseId, apiDomain).catch(() => undefined);
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  private register(
    doc: GradingRunDocument,
    clients: RunClients,
    meta: {
      courseKey: string;
      apiDomain: string | null;
      resumeCount: number;
      cancelRequested: boolean;
    },
  ): RunContext {
    // The session's saves also stamp checkpoint.lastSavedAt on the progress
    // doc (late-bound — the writer needs the session's owner id first).
    let progressRef: ProgressWriter | null = null;
    const store = {
      saveRun: async (d: GradingRunDocument) => {
        const path = await clients.runStore.saveRun(d);
        progressRef?.noteCheckpoint();
        return path;
      },
    };

    const session = new RunSession({
      document: doc,
      store,
      ownerId: this.instanceId,
      now: this.now,
      warn: this.warn,
      heartbeatMs: this.deps.heartbeatMs ?? HEARTBEAT_FLUSH_MS,
      staleGapMs: RUN_LOCK_STALE_S * 1000,
      peekLock: async () =>
        (await clients.runStore.loadRun(doc.canvasCourseId, doc.runId, meta.apiDomain))?.lock ?? null,
      onEvicted: () => void this.evict(doc.runId),
    });
    const progress = new ProgressWriter({
      store: this.deps.progressStore,
      document: doc,
      runId: doc.runId,
      courseKey: meta.courseKey,
      apiDomain: meta.apiDomain,
      owner: session.owner,
      resumeCount: meta.resumeCount,
      cancelRequested: meta.cancelRequested,
      createdAt: doc.createdAt,
      now: this.now,
      warn: this.warn,
    });
    progressRef = progress;
    session.onChange(() => progress.schedule());

    const controller = new AbortController();
    const live: LiveRun = {
      runId: doc.runId,
      session,
      progress,
      controller,
      cancelRequested: meta.cancelRequested,
    };
    this.deps.registry.create(live);

    const ctx: RunContext = {
      live,
      clients,
      grader: new GraderAgent({
        canvas: clients.canvas,
        profiles: clients.profiles,
        resources: clients.resources,
        discussions: this.discussions,
        llm: this.deps.llm,
        config: this.deps.config,
        warn: this.warn,
      }),
      quizGrader: new QuizGraderAgent({
        canvas: clients.canvas,
        profiles: clients.profiles,
        llm: this.deps.llm,
        config: this.deps.config,
        warn: this.warn,
      }),
      writeback: new WritebackService({
        canvas: clients.canvas,
        ledger: this.deps.ledger,
        auditFn: this.audit,
        warn: this.warn,
        now: this.now,
      }),
    };
    this.contexts.set(doc.runId, ctx);
    return ctx;
  }

  private enqueueGradeItems(ctx: RunContext, items: GradeItem[]): void {
    for (const item of items) {
      void this.gradeQueue.add(async () => {
        try {
          // Cancellation / pause are checked PER ITEM — skipped work stays
          // PENDING (a pause resumes it; a CANCELLED doc records it).
          if (ctx.live.cancelRequested || ctx.live.paused) return;
          const opts = {
            signal: ctx.live.controller.signal,
            isCancelled: () => ctx.live.cancelRequested,
            onPause: (signal: PauseSignal) => void this.pauseRun(ctx, signal),
          };
          if (item.quizSubmissionId != null && item.questionId != null) {
            await ctx.quizGrader.gradeOne(
              ctx.live.session,
              {
                canvasUserId: item.canvasUserId,
                quizSubmissionId: item.quizSubmissionId,
                questionId: item.questionId,
              },
              opts,
            );
          } else {
            await ctx.grader.gradeOne(ctx.live.session, item.canvasUserId, opts);
          }
          await this.checkRunPhase(ctx);
        } catch (err) {
          // Agents contain their own failures; this guards the phase check so
          // one bad item can't kill a consumer slot.
          this.warn(
            `[engine] Grade item failed unexpectedly in run ${ctx.live.runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
    }
  }

  private enqueueWriteback(ctx: RunContext, item: { canvasUserId: number; quizSubmissionId?: number }): void {
    void this.writebackQueue.add(async () => {
      try {
        if (ctx.live.cancelRequested || ctx.live.session.isEvicted) return;
        await ctx.writeback.postOne(ctx.live.session, item);
        await this.checkRunPhase(ctx);
      } catch (err) {
        this.warn(
          `[engine] Writeback item failed unexpectedly in run ${ctx.live.runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  /**
   * Moves the run to the status its rows imply (phaseFor), never away from a
   * terminal status. COMPLETED is terminal bookkeeping (unregister).
   */
  private async checkRunPhase(ctx: RunContext): Promise<void> {
    const doc = ctx.live.session.document;
    if (TERMINAL_RUN_STATUSES.includes(doc.status)) return;
    const rows: Array<{ status: GradeStatus; postedAt: string | null }> =
      doc.canvasQuizId != null ? doc.quizGrades : doc.grades;
    const next = phaseFor(rows);
    if (next === doc.status) return;
    await ctx.live.session.transition(next);
    if (next === 'COMPLETED') {
      await this.finalizeTerminal(ctx.live.runId);
    } else {
      await ctx.live.progress.writeNow();
    }
  }

  // ------------------------------------------------------------------ pause --

  /** Pauses a run (Codex usage limit / sign-in, Canvas token): queued work
   * stops, rows stay PENDING, the document says why. Idempotent. */
  private async pauseRun(ctx: RunContext, signal: PauseSignal): Promise<void> {
    if (ctx.live.paused) return;
    ctx.live.paused = signal;
    const doc = ctx.live.session.document;
    doc.pausedReason = signal.reason;
    doc.pausedMessage = signal.message;
    if (signal.until) doc.pausedUntil = signal.until;
    else delete doc.pausedUntil;
    this.warn(`[engine] Run ${doc.runId} paused (${signal.reason}).`);
    try {
      await ctx.live.session.flush();
      await ctx.live.progress.writeNow();
    } catch (err) {
      this.warn(
        `[engine] Could not checkpoint the pause of run ${doc.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (signal.until) this.scheduleUnpause(doc.runId, signal.until);
  }

  /**
   * Lifts every pause with this reason (e.g. canvas_auth after the teacher
   * fixed the token in ~/.aigrader/.env, codex_auth after `codex login`).
   * Returns the run ids resumed.
   */
  async resumePaused(reason: PauseSignal['reason']): Promise<string[]> {
    const resumed: string[] = [];
    for (const [runId, ctx] of this.contexts) {
      if (ctx.live.paused?.reason !== reason) continue;
      try {
        await this.unpause(runId);
        resumed.push(runId);
      } catch (err) {
        this.warn(
          `[engine] Could not resume paused run ${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return resumed;
  }

  /**
   * Another computer took this run over while this one was away (asleep,
   * offline): stop all local work on it WITHOUT writing another checkpoint,
   * and leave it out of this machine's resume sweep. Opening it here again
   * goes through resume, which sees the other computer's lock.
   */
  private async evict(runId: string): Promise<void> {
    const ctx = this.contexts.get(runId);
    if (!ctx) return;
    ctx.live.cancelRequested = true;
    ctx.live.controller.abort();
    this.contexts.delete(runId);
    const timer = this.unpauseTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.unpauseTimers.delete(runId);
    try {
      await this.deps.registry.remove(runId); // the session writes nothing now
      const record = await this.deps.progressStore.get(runId);
      if (record) await this.deps.progressStore.set(runId, { ...record, adopted: true });
    } catch (err) {
      this.warn(
        `[engine] Cleanup after run ${runId} moved to another computer failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Lifts a pause and re-queues every PENDING row. */
  private async unpause(runId: string): Promise<ResumeResult> {
    const ctx = this.contexts.get(runId);
    if (!ctx) return { outcome: 'already_live' };
    const timer = this.unpauseTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.unpauseTimers.delete(runId);
    ctx.live.paused = undefined;
    const doc = ctx.live.session.document;
    this.clearPauseFields(doc);

    const items: GradeItem[] =
      doc.canvasQuizId != null
        ? doc.quizGrades
            .filter((g) => g.status === 'PENDING')
            .map((g) => ({
              canvasUserId: g.canvasUserId,
              quizSubmissionId: g.quizSubmissionId,
              questionId: g.questionId,
            }))
        : doc.grades.filter((g) => g.status === 'PENDING').map((g) => ({ canvasUserId: g.canvasUserId }));
    await ctx.live.session.flush();
    await ctx.live.progress.writeNow();
    this.enqueueGradeItems(ctx, items);
    return { outcome: 'resumed', requeued: items.length, writebacks: 0 };
  }

  private scheduleUnpause(runId: string, untilIso: string): void {
    const existing = this.unpauseTimers.get(runId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, Date.parse(untilIso) - this.now().getTime()) + 5_000;
    const timer = setTimeout(() => {
      this.unpauseTimers.delete(runId);
      void this.unpause(runId).catch((err: unknown) =>
        this.warn(
          `[engine] Automatic resume of run ${runId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }, delay);
    timer.unref?.();
    this.unpauseTimers.set(runId, timer);
  }

  private clearPauseFields(doc: GradingRunDocument): void {
    delete doc.pausedReason;
    delete doc.pausedUntil;
    delete doc.pausedMessage;
  }

  // ---------------------------------------------------- one-run-at-a-time --

  /**
   * Refuses a second ACTIVE run (drafting or posting) on the same
   * assignment — two runs posting to the same students would double-comment.
   * Checks this machine's live runs and records, then the assignment's newest
   * run document in Canvas (another laptop's, if its lock is fresh).
   */
  private async assertNoActiveRun(
    clients: RunClients,
    courseKey: string,
    courseId: number,
    apiDomain: string | null,
    assignmentId: number,
  ): Promise<void> {
    const active: readonly RunStatus[] = ['PENDING', 'RUNNING', 'POSTING'];
    const refuse = (runId: string) => {
      throw new EngineError(
        'run_already_active',
        `A grading run for this assignment is still in progress (run ${runId}). Let it finish, or cancel it, before starting another.`,
      );
    };
    for (const ctx of this.contexts.values()) {
      const doc = ctx.live.session.document;
      if (
        doc.canvasCourseId === courseId &&
        doc.canvasAssignmentId === assignmentId &&
        active.includes(doc.status)
      ) {
        refuse(doc.runId);
      }
    }
    for (const rec of await this.deps.progressStore.listLive()) {
      if (rec.courseKey === courseKey && rec.canvasAssignmentId === assignmentId && active.includes(rec.status)) {
        refuse(rec.runId);
      }
    }
    try {
      const newest = (await clients.runStore.listRuns(courseId, apiDomain)).find(
        (r) => r.canvasAssignmentId === assignmentId,
      );
      if (!newest || this.contexts.has(newest.runId)) return;
      const doc = await clients.runStore.loadRun(courseId, newest.runId, apiDomain);
      const heartbeatMs = doc?.lock ? Date.parse(doc.lock.heartbeatUtc) : Number.NaN;
      if (
        doc &&
        active.includes(doc.status) &&
        doc.lock?.owner !== this.instanceId &&
        Number.isFinite(heartbeatMs) &&
        this.now().getTime() - heartbeatMs < RUN_LOCK_STALE_S * 1000
      ) {
        refuse(doc.runId);
      }
    } catch (err) {
      if (err instanceof EngineError) throw err;
      // A listing hiccup must not block grading — the local checks stand.
      this.warn(
        `[engine] Could not check Canvas for another active run: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Terminal bookkeeping: final progress write, unregister, drop the
   * context. */
  private async finalizeTerminal(runId: string): Promise<void> {
    const timer = this.unpauseTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.unpauseTimers.delete(runId);
    await this.deps.registry.remove(runId); // disposes session + progress (final writes)
    this.contexts.delete(runId);
  }

  /** Live context, auto-resuming from the checkpoint when needed. */
  private async requireLive(runId: string): Promise<RunContext> {
    let ctx = this.contexts.get(runId);
    if (ctx) return ctx;
    const result = await this.resume(runId);
    if (result.outcome === 'finalized_cancelled' || result.outcome === 'terminal') {
      throw new EngineError('run_not_live', `Run ${runId} is finished (${result.outcome}).`);
    }
    ctx = this.contexts.get(runId);
    if (!ctx) throw new EngineError('run_not_live', `Run ${runId} could not be made live.`);
    return ctx;
  }
}

// ------------------------------------------------------------------ helpers --

/** Parses the numeric score out of a draft's "score/total" string. */
export function scoreOf(draft: GraderDraft): number | null {
  const slash = draft.totalPoints.indexOf('/');
  const head = slash >= 0 ? draft.totalPoints.slice(0, slash) : draft.totalPoints;
  const score = Number.parseFloat(head);
  return Number.isFinite(score) ? score : null;
}

/** Canvas wire rubric criteria → the run document's snapshot shape (raw ids
 * preserved verbatim — the silent-drop rule). */
export function toRubricSnapshot(
  criteria: readonly CanvasRubricCriterion[],
): RubricCriterionSnapshot[] {
  return criteria.map((c) => ({
    id: c.id,
    description: c.description ?? null,
    long_description: c.long_description ?? null,
    points: c.points,
    learning_outcome_id:
      c.learning_outcome_id == null || String(c.learning_outcome_id).trim() === ''
        ? null
        : Number(c.learning_outcome_id),
    ratings:
      c.ratings?.map((r) => ({
        id: r.id,
        description: r.description ?? null,
        long_description: r.long_description ?? null,
        points: r.points,
      })) ?? null,
  }));
}
