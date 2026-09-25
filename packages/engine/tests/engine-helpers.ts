// Shared in-memory fakes for the engine suites: run store, progress store,
// Canvas port, and a fully-wired engine builder. NEVER a real network or
// model call (the model rides the injectable modelCall seam; Canvas is a
// plain object).

import type {
  CanvasAssignment,
  CanvasSubmission,
  CourseUser,
  DiscussionEntry,
  QuizQuestion,
  QuizSubmissionAnswer,
  QuizSubmissionRef,
  RunListEntry,
} from '@aigrader/canvas';
import {
  AssignmentPrepSettingsSchema,
  CourseSettingsProfileSchema,
  GradingRunDocumentSchema,
  type GradingRunDocument,
  type RunProgressDoc,
  type StudentGrade,
} from '@aigrader/shared';
import { GradingEngine, type EngineCanvasPort, type EngineConfig, type RunClients } from '../src/coordinator/engine.js';
import { RunRegistry } from '../src/coordinator/registry.js';
import { StructuredGradingClient, type ModelCallFn } from '../src/llm/structured-client.js';
import type { ProgressStorePort } from '../src/progress/progress-writer.js';
import { TERMINAL_RUN_STATUSES } from '../src/coordinator/run-session.js';
import type { RunStorePort } from '../src/coordinator/engine.js';

export const TEST_HOST = 'school.instructure.com';
export const TEST_COURSE_KEY = `${TEST_HOST}#77`;
export const TEST_COURSE_ID = 77;
export const TEST_ASSIGNMENT_ID = 501;

// ------------------------------------------------------------------ clock --

/** Mutable test clock (drives session debounce + progress coalescing). */
export class TestClock {
  constructor(public ms = Date.parse('2026-06-10T16:00:00.000Z')) {}
  now = (): Date => new Date(this.ms);
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

// -------------------------------------------------------------- run store --

export class FakeRunStore implements RunStorePort {
  saves: GradingRunDocument[] = [];
  docs = new Map<string, GradingRunDocument>();
  failNextSave = false;
  failAlways = false;
  /** Every save attempt, successful or not. */
  attempts = 0;

  async saveRun(doc: GradingRunDocument): Promise<string> {
    this.attempts += 1;
    if (this.failNextSave || this.failAlways) {
      this.failNextSave = false;
      throw new Error('saveRun failed (test-injected)');
    }
    const copy = structuredClone(doc);
    this.saves.push(copy);
    this.docs.set(doc.runId, copy);
    return `runs/run-a${doc.canvasAssignmentId}-stamp-${doc.runId}.json`;
  }

  async loadRun(courseId: number, runId: string): Promise<GradingRunDocument | null> {
    const doc = this.docs.get(runId);
    if (!doc || doc.canvasCourseId !== courseId) return null;
    return structuredClone(doc);
  }

  async listRuns(courseId: number): Promise<RunListEntry[]> {
    return [...this.docs.values()]
      .filter((d) => d.canvasCourseId === courseId)
      .map((d) => ({
        runId: d.runId,
        canvasAssignmentId: d.canvasAssignmentId,
        createdAt: d.createdAt,
        filename: `run-a${d.canvasAssignmentId}-stamp-${d.runId}.json`,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get lastSave(): GradingRunDocument {
    if (this.saves.length === 0) throw new Error('No saves recorded.');
    return this.saves[this.saves.length - 1]!;
  }
}

// --------------------------------------------------------- progress store --

export class FakeProgressStore implements ProgressStorePort {
  docs = new Map<string, RunProgressDoc>();
  writes: RunProgressDoc[] = [];

  async set(runId: string, doc: RunProgressDoc): Promise<void> {
    this.docs.set(runId, structuredClone(doc));
    this.writes.push(structuredClone(doc));
  }

  async get(runId: string): Promise<RunProgressDoc | null> {
    const doc = this.docs.get(runId);
    return doc ? structuredClone(doc) : null;
  }

  async listLive(): Promise<RunProgressDoc[]> {
    return [...this.docs.values()]
      .filter((d) => !TERMINAL_RUN_STATUSES.includes(d.status) && d.adopted !== true)
      .map((d) => structuredClone(d));
  }

  async requestCancel(runId: string): Promise<void> {
    const doc = this.docs.get(runId);
    if (doc) doc.cancelRequested = true;
  }

  get last(): RunProgressDoc {
    if (this.writes.length === 0) throw new Error('No progress writes recorded.');
    return this.writes[this.writes.length - 1]!;
  }
}

// ------------------------------------------------------------ canvas fake --

export class FakeCanvas implements EngineCanvasPort {
  assignment: CanvasAssignment = {
    id: TEST_ASSIGNMENT_ID,
    name: 'Essay 1',
    description: '<p>Write an essay.</p>',
    submission_types: ['online_upload'],
    points_possible: 20,
    due_at: null,
    needs_grading_count: null,
    has_submitted_submissions: true,
    published: true,
    grading_type: 'points',
    quiz_id: null,
    discussion_topic: null,
    rubric: null,
    rubric_settings: null,
  };
  submissions: CanvasSubmission[] = [];
  students: CourseUser[] = [];
  quizQuestions: QuizQuestion[] = [];
  quizSubmissions: QuizSubmissionRef[] = [];
  /** quizSubmissionId → answers. */
  quizAnswers = new Map<number, QuizSubmissionAnswer[]>();
  discussionEntries: DiscussionEntry[] = [];
  /** url → bytes; a missing url throws (transient download failure). */
  files = new Map<string, Buffer>();

  postedGrades: Array<{ courseId: number; assignmentId: number; userId: number; args: unknown }> =
    [];
  postedQuizGrades: Array<{
    courseId: number;
    quizId: number;
    quizSubmissionId: number;
    args: { attempt: number; questions: Record<string, { score?: number; comment?: string }> };
  }> = [];
  failPostGradeFor = new Set<number>();
  failQuizPost = false;

  async getAssignment(): Promise<CanvasAssignment> {
    return this.assignment;
  }

  async getSubmissions(): Promise<CanvasSubmission[]> {
    return this.submissions;
  }

  async getSubmission(
    _courseId: number,
    _assignmentId: number,
    userId: number,
  ): Promise<CanvasSubmission | null> {
    return this.submissions.find((s) => s.user_id === userId) ?? null;
  }

  async getCourseStudents(): Promise<CourseUser[]> {
    return this.students;
  }

  async getQuizQuestions(): Promise<QuizQuestion[]> {
    return this.quizQuestions;
  }

  async getQuizSubmissions(): Promise<QuizSubmissionRef[]> {
    return this.quizSubmissions;
  }

  async getQuizSubmissionAnswers(quizSubmissionId: number): Promise<QuizSubmissionAnswer[]> {
    return this.quizAnswers.get(quizSubmissionId) ?? [];
  }

  async getDiscussionEntries(): Promise<DiscussionEntry[]> {
    return this.discussionEntries;
  }

  async downloadUrl(url: string): Promise<Buffer> {
    const bytes = this.files.get(url);
    if (!bytes) throw new Error(`download failed: ${url}`);
    return bytes;
  }

  async postGrade(
    courseId: number,
    assignmentId: number,
    userId: number,
    args: unknown,
  ): Promise<{ id: number | null; score: number | null; grade: string | null }> {
    if (this.failPostGradeFor.has(userId)) {
      throw new Error(`Canvas 500 for user ${userId}`);
    }
    this.postedGrades.push({ courseId, assignmentId, userId, args });
    return { id: 1, score: null, grade: null };
  }

  async postQuizQuestionGrades(
    courseId: number,
    quizId: number,
    quizSubmissionId: number,
    args: { attempt: number; questions: Record<string, { score?: number; comment?: string }> },
  ): Promise<void> {
    if (this.failQuizPost) throw new Error('Canvas 500 (quiz)');
    this.postedQuizGrades.push({ courseId, quizId, quizSubmissionId, args });
  }
}

// -------------------------------------------------------------- doc/grade --

export function makeGrade(overrides: Partial<StudentGrade> & { canvasUserId: number }): StudentGrade {
  return {
    canvasUserId: overrides.canvasUserId,
    studentName: overrides.studentName ?? `Student ${overrides.canvasUserId}`,
    submissionType: overrides.submissionType ?? 'online_upload',
    attachmentMime: overrides.attachmentMime ?? null,
    attachmentCount: overrides.attachmentCount ?? 0,
    extractionWarnings: overrides.extractionWarnings ?? [],
    submittedAt: overrides.submittedAt ?? null,
    status: overrides.status ?? 'PENDING',
    submissionExcerpt: overrides.submissionExcerpt ?? null,
    excerptTruncated: overrides.excerptTruncated ?? false,
    aiDraft: overrides.aiDraft ?? null,
    facultyEdited: overrides.facultyEdited ?? null,
    llm: overrides.llm ?? null,
    errorMessage: overrides.errorMessage ?? null,
    postedAt: overrides.postedAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-06-10T15:00:00.000Z',
    ...(overrides.errorKind ? { errorKind: overrides.errorKind } : {}),
    ...(overrides.approvedBy ? { approvedBy: overrides.approvedBy } : {}),
    ...(overrides.editSource ? { editSource: overrides.editSource } : {}),
    ...(overrides.staleEdit != null ? { staleEdit: overrides.staleEdit } : {}),
  };
}

export function makeRunDoc(overrides: Partial<GradingRunDocument> = {}): GradingRunDocument {
  return GradingRunDocumentSchema.parse({
    schemaVersion: 1,
    runId: 'run1',
    canvasCourseId: TEST_COURSE_ID,
    canvasApiDomain: TEST_HOST,
    canvasAssignmentId: TEST_ASSIGNMENT_ID,
    assignmentName: 'Essay 1',
    pointsPossible: 20,
    facultyCanvasUserId: 9,
    facultyName: 'John Doe',
    status: 'PENDING',
    createdAt: '2026-06-10T15:00:00.000Z',
    updatedAt: '2026-06-10T15:00:00.000Z',
    ...overrides,
  });
}

// ----------------------------------------------------------------- engine --

export const defaultProfiles = {
  get: async () => CourseSettingsProfileSchema.parse({}),
};

export const defaultResources = {
  getPrep: async () => AssignmentPrepSettingsSchema.parse({}),
  downloadMaterial: async () => null,
  list: async () => [],
};

export const TEST_CONFIG: EngineConfig = {
  gradeConcurrency: 8,
  writebackConcurrency: 2,
  model: 'test-model',
  reasoningEffort: '',
};

/** A GraderOutput JSON body the fake model returns. */
export function graderOutputJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    TotalPoints: '18/20',
    assignmentFeedback: 'Nice work overall.',
    Rubrics: [],
    ...overrides,
  });
}

export interface TestEngineHarness {
  engine: GradingEngine;
  registry: RunRegistry;
  progressStore: FakeProgressStore;
  runStore: FakeRunStore;
  canvas: FakeCanvas;
  clock: TestClock;
  /** Every request the fake model received (ModelRequest shape). */
  modelCalls: unknown[];
}

export function buildEngine(
  opts: {
    modelCall?: ModelCallFn;
    canvas?: FakeCanvas;
    clients?: (base: RunClients) => RunClients;
    /** Share one Canvas folder / clock between two engines (multi-machine drills). */
    runStore?: FakeRunStore;
    clock?: TestClock;
    progressStore?: ProgressStorePort;
    instanceId?: string;
    /** 0 = no heartbeat-only flushes (drills flush explicitly). */
    heartbeatMs?: number;
  } = {},
): TestEngineHarness {
  const clock = opts.clock ?? new TestClock();
  const registry = new RunRegistry();
  const progressStore = (opts.progressStore ?? new FakeProgressStore()) as FakeProgressStore;
  const runStore = opts.runStore ?? new FakeRunStore();
  const canvas = opts.canvas ?? new FakeCanvas();

  const modelCalls: unknown[] = [];
  const call: ModelCallFn =
    opts.modelCall ??
    (async () => ({ text: graderOutputJson(), usage: { inputTokens: 100, outputTokens: 40 } }));

  const llm = new StructuredGradingClient({
    modelCall: async (request) => {
      modelCalls.push(request);
      return call(request);
    },
    sleep: async () => {},
    maxAttempts: 1,
  });

  const baseClients: RunClients = {
    canvas,
    runStore,
    profiles: defaultProfiles,
    resources: defaultResources,
  };
  const clients = opts.clients ? opts.clients(baseClients) : baseClients;

  let seq = 0;
  const engine = new GradingEngine({
    registry,
    progressStore,
    llm,
    clients: async () => clients,
    config: TEST_CONFIG,
    now: clock.now,
    warn: () => {},
    auditFn: () => {},
    newRunId: () => (seq++ === 0 ? 'run1' : `run${seq}`),
    instanceId: opts.instanceId ?? 'test:me',
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });

  return {
    engine,
    registry,
    progressStore,
    runStore,
    canvas,
    clock,
    modelCalls,
  };
}

/** Tears down every live session (stops intervals) after a test. */
export async function shutdown(harness: TestEngineHarness): Promise<void> {
  await harness.engine.onIdle();
  for (const live of harness.registry.list()) {
    await harness.registry.remove(live.runId);
  }
}

/** A text-entry submission row. */
export function textSubmission(userId: number, body: string, overrides: Partial<CanvasSubmission> = {}): CanvasSubmission {
  return {
    id: 9000 + userId,
    user_id: userId,
    assignment_id: TEST_ASSIGNMENT_ID,
    attempt: 1,
    workflow_state: 'submitted',
    late: false,
    seconds_late: 0,
    attachments: null,
    body,
    url: null,
    submission_type: 'online_text_entry',
    submitted_at: '2026-06-09T10:00:00Z',
    score: null,
    graded_at: null,
    submission_history: null,
    ...overrides,
  };
}

export function student(id: number, name?: string): CourseUser {
  return { id, name: name ?? `Student ${id}`, sortable_name: null, short_name: null, avatar_url: null };
}

/** A progress record as the writer would have persisted it (resume/sweep seeds). */
export function makeProgressDoc(overrides: Partial<RunProgressDoc> = {}): RunProgressDoc {
  return {
    runId: 'run1',
    canvasCourseId: TEST_COURSE_ID,
    canvasAssignmentId: TEST_ASSIGNMENT_ID,
    apiDomain: TEST_HOST,
    courseKey: TEST_COURSE_KEY,
    status: 'RUNNING',
    counts: {
      total: 0,
      pending: 0,
      extracting: 0,
      scoring: 0,
      drafted: 0,
      edited: 0,
      approved: 0,
      posted: 0,
      errors: 0,
    },
    cancelRequested: false,
    worker: { owner: 'rev-dead:xyz', heartbeatAt: '2026-06-10T15:00:00.000Z', resumeCount: 0 },
    checkpoint: { lastSavedAt: '2026-06-10T15:00:00.000Z' },
    createdAt: '2026-06-10T14:00:00.000Z',
    updatedAt: '2026-06-10T15:00:00.000Z',
    ...overrides,
  };
}
