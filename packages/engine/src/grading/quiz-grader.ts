// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\QuizGraderAgent.cs
// (itself a port of the TS app's grade-quiz-question.ts).
//
// Per-question quiz grading: one LLM call per (student attempt × essay
// question), the quiz counterpart of GraderAgent. Deliberately a plain call
// (no rubric mapping), returning { score, comment } clamped to the
// question's point range. Mirrors GraderAgent's status/error/cancel
// conventions.

import type { QuizSubmissionAnswer } from '@aigrader/canvas';
import type { CourseSettingsProfile } from '@aigrader/shared';
import { renderCourseProfileText } from '@aigrader/shared';
import type { GradingLlm } from '../llm/structured-client.js';
import { clampQuizScore } from '../llm/response-schemas.js';
import type { RunSession } from '../coordinator/run-session.js';
import { pauseSignalOf, type PauseSignal } from '../coordinator/pause.js';
import {
  QUIZ_QUESTION_SYSTEM_PROMPT,
  buildQuizQuestionUserMessage,
} from './prompts/quiz-prompt.js';
import { stripHtml } from './prompts/strip-html.js';
import { EXCERPT_LENGTH } from './grader-agent.js';

export interface QuizCanvasPort {
  getQuizSubmissionAnswers(quizSubmissionId: number): Promise<QuizSubmissionAnswer[]>;
}

export interface QuizGraderDeps {
  canvas: QuizCanvasPort;
  profiles: { get(courseId: number, apiDomain?: string | null): Promise<CourseSettingsProfile> };
  llm: Pick<GradingLlm, 'gradeQuizQuestion'>;
  config: {
    model: string;
    reasoningEffort?: string;
    maxOutputTokens?: number;
  };
  warn?: (message: string) => void;
}

export interface QuizGradeItem {
  canvasUserId: number;
  quizSubmissionId: number;
  questionId: number;
}

export interface QuizGradeOneOptions {
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  /** Called when a failure should pause the whole run (row back to PENDING). */
  onPause?: (signal: PauseSignal) => void;
}

/** Produces one AI draft for one quiz question answer. */
export class QuizGraderAgent {
  private readonly deps: QuizGraderDeps;

  constructor(deps: QuizGraderDeps) {
    this.deps = deps;
  }

  /** Grades one quiz answer: fetch the answer → quiz prompt → LLM → clamped
   * draft. Never throws; failures land on the row as ERROR. */
  async gradeOne(
    session: RunSession,
    item: QuizGradeItem,
    opts: QuizGradeOneOptions = {},
  ): Promise<void> {
    const doc = session.document;
    const { quizSubmissionId, questionId } = item;
    const cancelled = () => opts.isCancelled?.() === true || opts.signal?.aborted === true;
    if (cancelled()) return;

    try {
      session.updateQuizGrade(quizSubmissionId, questionId, (g) => {
        g.status = 'EXTRACTING';
      });

      const question = doc.quizQuestionSnapshot.find((q) => q.questionId === questionId);
      if (!question) {
        throw new Error(`Question ${questionId} missing from the run snapshot.`);
      }

      // The student's answer: essays arrive as a JSON string in the
      // per-submission answers payload. Quiz-submission ids are per-instance,
      // so the engine bound `canvas` to the run's domain already.
      const answers = await this.deps.canvas.getQuizSubmissionAnswers(quizSubmissionId);
      const answer = answers.find((a) => a.id === questionId);
      const answerText =
        typeof answer?.answer === 'string' ? stripHtml(answer.answer) : '';

      if (answerText.trim() === '') {
        throw new Error('The student left this question blank (no answer text).');
      }
      if (cancelled()) return;

      session.updateQuizGrade(quizSubmissionId, questionId, (g) => {
        g.answerExcerpt =
          answerText.length <= EXCERPT_LENGTH ? answerText : answerText.slice(0, EXCERPT_LENGTH);
        g.status = 'SCORING';
      });

      const courseProfileText =
        doc.prepSnapshot?.profileText ??
        renderCourseProfileText(
          await this.deps.profiles.get(doc.canvasCourseId, doc.canvasApiDomain),
        );
      const userMessage = buildQuizQuestionUserMessage({
        courseProfileText,
        questionName: question.questionName,
        questionTextHtml: question.questionTextHtml,
        maxPoints: question.maxPoints,
        correctComments: question.correctComments,
        neutralComments: question.neutralComments,
        studentAnswerText: answerText,
        additionalInstructions: doc.additionalInstructions,
      });

      const result = await this.deps.llm.gradeQuizQuestion({
        systemPrompt: QUIZ_QUESTION_SYSTEM_PROMPT,
        userMessage,
        model: this.deps.config.model,
        reasoningEffort: this.deps.config.reasoningEffort,
        maxOutputTokens: this.deps.config.maxOutputTokens,
        signal: opts.signal,
      });

      // The prompt instructs the range; the clamp guarantees it.
      const score = clampQuizScore(result.output.score, question.maxPoints);

      session.updateQuizGrade(quizSubmissionId, questionId, (g) => {
        g.aiDraft = { score, comment: result.output.comment };
        if (g.facultyEdited != null) g.staleEdit = true;
        g.errorKind = undefined;
        g.status = g.facultyEdited != null ? 'EDITED' : 'DRAFT';
        g.errorMessage = null;
      });
    } catch (err) {
      if (cancelled()) return; // shutdown/cancel — reconciliation owns the row
      const pause = pauseSignalOf(err);
      if (pause) {
        session.updateQuizGrade(quizSubmissionId, questionId, (g) => {
          g.status = 'PENDING';
        });
        opts.onPause?.(pause);
        return;
      }
      session.updateQuizGrade(quizSubmissionId, questionId, (g) => {
        g.status = 'ERROR';
        g.errorKind = 'grade';
        g.errorMessage = err instanceof Error ? err.message : String(err);
      });
    }
  }
}
