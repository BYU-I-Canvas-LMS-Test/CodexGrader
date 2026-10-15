// Structured grading calls over an injected model backend.
//
// Retry/repair policy ported from the hosted TypeScript build's model client,
// itself
// from C:\Devs\AudioBookFire\workers\audio-pipeline\index.js (transient
// 429/5xx/network retries with exponential backoff; empty responses re-rolled;
// other 4xx surface immediately). Call surface cross-checked against
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Ai\OpenAiGraderClient.cs
// (IGraderLlmClient / LlmResult / LlmStats shape).
//
// The model call itself is INJECTED (`modelCall`): in production it is the
// Codex backend (packages/codex — one isolated `codex exec` per call, given
// the strict output schema); in tests it is a fake. Each call carries a
// per-call strict JSON Schema that pins criterion/rating ids to the exact
// rubric-snapshot strings (see response-schemas.ts); the zod schemas remain
// the validation gate with ONE repair retry on failure (validation-failure
// repair exhausted ⇒ deterministic ⇒ the engine marks the row ERROR — this
// module never throws raw backend errors).

import type { z } from 'zod';
import {
  AssignmentAlignmentSchema,
  buildAlignmentResponseSchema,
  type AssignmentAlignment,
} from './alignment-schemas.js';
import type { JsonSchema } from './json-schema.js';
import {
  GraderOutputSchema,
  QuizQuestionGraderOutputSchema,
  buildGradeSubmissionResponseSchema,
  buildQuizQuestionResponseSchema,
  type GraderOutput,
  type QuizQuestionGraderOutput,
  type ResponseSchemaCriterion,
} from './response-schemas.js';

/** Per-attempt hard timeout (composed with any caller signal). */
export const LLM_CALL_TIMEOUT_MS = 300_000;
/** Transient-failure attempts (5xx/network/timeout/empty responses). */
export const LLM_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_JITTER_MS = 500;

// Rate limits (HTTP 429). By the time Codex reports a 429 it has already
// retried for a few seconds itself, so the limit is a per-minute one: wait
// in tens of seconds, not one or two. The cool-down is SHARED by every call
// this client makes, so concurrent graders back off together instead of
// each one hammering a limit that has already tripped.
/** Attempts while Codex keeps answering 429, before the run pauses. */
export const RATE_LIMIT_MAX_ATTEMPTS = 4;
/** First cool-down; doubles per consecutive 429 (15s, 30s, 60s, …). */
export const RATE_LIMIT_BACKOFF_BASE_MS = 15_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 120_000;
const RATE_LIMIT_JITTER_MS = 1_000;
/** After a cool-down, the calls that were held restart this far apart. */
export const RATE_LIMIT_STAGGER_MS = 2_000;
/** How long a run pauses (then resumes itself) when 429s persist. */
export const RATE_LIMIT_PAUSE_MS = 5 * 60_000;

/** Token usage and latency for one grading call (recorded on the run doc). */
export type LlmStats = {
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  /** Prompt tokens the backend served from its prompt cache. */
  cachedTokens?: number;
  /** Reasoning tokens the model spent. */
  thoughtsTokens?: number;
  durationMs: number;
};

/** The result of a structured LLM call: parsed output + accounting. */
export type LlmResult<T> = { output: T; stats: LlmStats };

/**
 * Why a call failed in a way the RUN (not just the row) must react to. The
 * engine pauses a run on `usage_limit` / `rate_limited` / `auth` instead of
 * erroring every row.
 */
export type GradingFailureKind =
  | 'usage_limit'
  | 'rate_limited'
  | 'auth'
  | 'model_unavailable'
  | 'refusal';

/**
 * Every failure of a grading call surfaces as this typed error — the engine
 * marks the row ERROR (and may re-queue when `retryable`). Raw backend errors
 * never escape; they ride along as `cause`.
 */
export class GradingCallError extends Error {
  readonly retryable: boolean;
  readonly kind?: GradingFailureKind;
  /** When a usage limit resets / a rate-limit pause lifts (ISO), if known. */
  readonly resetsAt?: string;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: { retryable: boolean; kind?: GradingFailureKind; resetsAt?: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'GradingCallError';
    this.retryable = opts.retryable;
    this.kind = opts.kind;
    this.resetsAt = opts.resetsAt;
    this.cause = opts.cause;
  }
}

/** One model invocation, as the backend sees it. */
export type ModelRequest = {
  model: string;
  /** "low" | "medium" | "high" (backend-interpreted); absent = backend default. */
  reasoningEffort?: string;
  systemPrompt: string;
  userText: string;
  /** Vision parts, in submission order. */
  images: { mimeType: string; base64: string }[];
  /** The REQUIRED output shape (strict JSON Schema). */
  responseSchema: JsonSchema;
  maxOutputTokens?: number;
  /** Per-attempt abort (timeout ∪ caller cancellation). */
  signal: AbortSignal;
};

/** What a backend returns: the model's final text (JSON) + usage. */
export type ModelResponse = {
  text?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  };
};

/**
 * The backend seam. Throw an error carrying a numeric `status` for HTTP-like
 * failures (429/5xx retry; other 4xx don't), a plain error for network-ish
 * failures (retried), or a GradingCallError to control the outcome exactly
 * (e.g. usage limits — never retried here).
 */
export type ModelCallFn = (request: ModelRequest) => Promise<ModelResponse>;

export type StructuredGradingClientOptions = {
  /** The backend (Codex in production; a fake in tests). REQUIRED. */
  modelCall: ModelCallFn;
  /** Per-attempt timeout override (tests). */
  timeoutMs?: number;
  /** Transient-attempt override (tests). */
  maxAttempts?: number;
  /** Rate-limit attempt override (tests). */
  rateLimitAttempts?: number;
  /** Injectable backoff sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1) (tests). */
  random?: () => number;
  /** Injectable clock, epoch ms (tests). */
  now?: () => number;
};

export type GradeSubmissionCall = {
  systemPrompt: string;
  userMessage: string;
  /** Vision parts, in submission order (multimodal grading). */
  images?: { mimeType: string; base64: string }[];
  /** The rubric snapshot's raw ids — pins the per-call schema enums. */
  criteria: readonly ResponseSchemaCriterion[];
  model: string;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  /** Caller cancellation (run cancel/shutdown) — composed with the timeout. */
  signal?: AbortSignal;
};

export type GradeQuizQuestionCall = {
  systemPrompt: string;
  userMessage: string;
  model: string;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

/** One assignment's alignment review — instructor-authored inputs only,
 * never student work. Same retry/repair machinery as grading calls. */
export type AlignmentReviewCall = {
  systemPrompt: string;
  userMessage: string;
  model: string;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

/** Internal shape of one structured call. */
type StructuredCall = {
  model: string;
  reasoningEffort?: string;
  systemPrompt: string;
  userText: string;
  images: { mimeType: string; base64: string }[];
  responseSchema: JsonSchema;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

/** The three structured calls the engine makes (grading + alignment). */
export interface GradingLlm {
  gradeSubmission(call: GradeSubmissionCall): Promise<LlmResult<GraderOutput>>;
  gradeQuizQuestion(call: GradeQuizQuestionCall): Promise<LlmResult<QuizQuestionGraderOutput>>;
  reviewAlignment(call: AlignmentReviewCall): Promise<LlmResult<AssignmentAlignment>>;
}

export class StructuredGradingClient implements GradingLlm {
  private readonly modelCall: ModelCallFn;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly rateLimitAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  /** No call starts before this (epoch ms) — the shared 429 cool-down. */
  private coolDownUntil = 0;
  /** The next staggered start slot for calls held by a cool-down. */
  private nextStart = 0;

  constructor(opts: StructuredGradingClientOptions) {
    this.modelCall = opts.modelCall;
    this.timeoutMs = opts.timeoutMs ?? LLM_CALL_TIMEOUT_MS;
    this.maxAttempts = opts.maxAttempts ?? LLM_MAX_ATTEMPTS;
    this.rateLimitAttempts = opts.rateLimitAttempts ?? RATE_LIMIT_MAX_ATTEMPTS;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /** Grades one assignment submission; returns the rubric-shaped output. */
  async gradeSubmission(call: GradeSubmissionCall): Promise<LlmResult<GraderOutput>> {
    return this.callStructured(
      {
        model: call.model,
        reasoningEffort: call.reasoningEffort,
        systemPrompt: call.systemPrompt,
        userText: call.userMessage,
        images: call.images ?? [],
        responseSchema: buildGradeSubmissionResponseSchema(call.criteria),
        maxOutputTokens: call.maxOutputTokens,
        signal: call.signal,
      },
      GraderOutputSchema,
    );
  }

  /** Grades one quiz question answer; returns score + comment. */
  async gradeQuizQuestion(
    call: GradeQuizQuestionCall,
  ): Promise<LlmResult<QuizQuestionGraderOutput>> {
    return this.callStructured(
      {
        model: call.model,
        reasoningEffort: call.reasoningEffort,
        systemPrompt: call.systemPrompt,
        userText: call.userMessage,
        images: [],
        responseSchema: buildQuizQuestionResponseSchema(),
        maxOutputTokens: call.maxOutputTokens,
        signal: call.signal,
      },
      QuizQuestionGraderOutputSchema,
    );
  }

  /** Reviews one assignment's outcome/rubric/instruction coherence. */
  async reviewAlignment(call: AlignmentReviewCall): Promise<LlmResult<AssignmentAlignment>> {
    return this.callStructured(
      {
        model: call.model,
        reasoningEffort: call.reasoningEffort,
        systemPrompt: call.systemPrompt,
        userText: call.userMessage,
        images: [],
        responseSchema: buildAlignmentResponseSchema(),
        maxOutputTokens: call.maxOutputTokens,
        signal: call.signal,
      },
      AssignmentAlignmentSchema,
    );
  }

  // ------------------------------------------------------------- internals --

  /**
   * One structured call: transient-retried model call → JSON.parse → zod
   * validation, with ONE repair retry (validation error appended to the user
   * message) before the failure is declared deterministic.
   */
  private async callStructured<S extends z.ZodTypeAny>(
    call: StructuredCall,
    outputSchema: S,
  ): Promise<LlmResult<z.output<S>>> {
    const started = Date.now();

    let response = await this.callModelWithRetry(call);
    let parsed = parseAndValidate(response.text ?? '', outputSchema);

    if (!parsed.ok) {
      // ONE repair retry: same call with the validation error appended.
      const repairCall: StructuredCall = {
        ...call,
        userText:
          `${call.userText}\n\n` +
          `Your previous response was rejected: ${parsed.problem}\n` +
          `Return ONLY corrected JSON that satisfies the required schema exactly.`,
      };
      response = await this.callModelWithRetry(repairCall);
      parsed = parseAndValidate(response.text ?? '', outputSchema);
      if (!parsed.ok) {
        // Same input ⇒ same failure — deterministic, never re-queued.
        throw new GradingCallError(
          `The AI response failed validation after a repair attempt: ${parsed.problem}`,
          { retryable: false },
        );
      }
    }

    return {
      output: parsed.value,
      stats: {
        model: call.model,
        promptTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        cachedTokens: response.usage?.cachedTokens,
        thoughtsTokens: response.usage?.reasoningTokens,
        durationMs: Date.now() - started,
      },
    };
  }

  /**
   * The retry loop. Transient failures — 5xx, network errors (no status),
   * timeout aborts, and empty responses (re-rolled) — get up to maxAttempts
   * with 1s*2^(n-1) backoff + 0–500ms jitter. A 429 instead opens the shared
   * cool-down (15s, 30s, 60s, …) and, after rateLimitAttempts, fails as
   * `rate_limited` so the engine pauses the run rather than erroring rows.
   * Non-retryable: other 4xx, caller cancellation, and any GradingCallError
   * the backend throws itself (usage limits, auth, refusals — the backend
   * already classified them).
   */
  private async callModelWithRetry(call: StructuredCall): Promise<ModelResponse> {
    let attempt = 0;
    let transientFailures = 0;
    let rateLimits = 0;
    for (;;) {
      await this.waitForCoolDown(call.signal);
      if (call.signal?.aborted) {
        throw new GradingCallError('The grading call was cancelled.', { retryable: false });
      }
      attempt++;

      // Per-attempt timeout, composed with the caller's signal.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onCallerAbort = () => controller.abort();
      call.signal?.addEventListener('abort', onCallerAbort, { once: true });

      try {
        const response = await this.modelCall({
          model: call.model,
          reasoningEffort: call.reasoningEffort,
          systemPrompt: call.systemPrompt,
          userText: call.userText,
          images: call.images,
          responseSchema: call.responseSchema,
          maxOutputTokens: call.maxOutputTokens,
          signal: controller.signal,
        });
        const text = response.text;
        if (text != null && text.trim().length > 0) return response;
        // Empty response: re-roll a fresh attempt.
        transientFailures++;
        if (transientFailures >= this.maxAttempts) {
          throw new GradingCallError(
            `The model returned an empty response after ${attempt} attempt(s).`,
            { retryable: true },
          );
        }
      } catch (err) {
        if (err instanceof GradingCallError) throw err;
        if (call.signal?.aborted) {
          throw new GradingCallError('The grading call was cancelled.', {
            retryable: false,
            cause: err,
          });
        }
        const status = errorStatus(err);
        if (status === 429) {
          rateLimits++;
          if (rateLimits >= this.rateLimitAttempts) {
            throw new GradingCallError(
              `Codex is getting too many requests right now (HTTP 429), still after ${attempt} attempt(s): ${errorMessage(err)}`,
              {
                retryable: true,
                kind: 'rate_limited',
                resetsAt: new Date(this.now() + RATE_LIMIT_PAUSE_MS).toISOString(),
                cause: err,
              },
            );
          }
          this.openCoolDown(rateLimits);
          continue; // the next pass waits the cool-down out
        }
        const retryable = status === undefined || status >= 500;
        if (!retryable) {
          throw new GradingCallError(
            `The model rejected the grading request (HTTP ${status}): ${errorMessage(err)}`,
            { retryable: false, cause: err },
          );
        }
        transientFailures++;
        if (transientFailures >= this.maxAttempts) {
          throw new GradingCallError(
            `The grading call failed after ${attempt} attempt(s): ${errorMessage(err)}`,
            { retryable: true, cause: err },
          );
        }
      } finally {
        clearTimeout(timer);
        call.signal?.removeEventListener('abort', onCallerAbort);
      }

      // Both the empty-response and transient-error paths back off here.
      await this.sleep(
        BACKOFF_BASE_MS * 2 ** (transientFailures - 1) + this.random() * BACKOFF_JITTER_MS,
      );
    }
  }

  /** Opens (or extends) the shared cool-down after the n-th 429 in a row. */
  private openCoolDown(streak: number): void {
    const delay =
      Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (streak - 1), RATE_LIMIT_BACKOFF_MAX_MS) +
      this.random() * RATE_LIMIT_JITTER_MS;
    this.coolDownUntil = Math.max(this.coolDownUntil, this.now() + delay);
  }

  /** Waits out an active cool-down. Calls it held restart a couple of
   * seconds apart, not all at once (that would just trip the limit again). */
  private async waitForCoolDown(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    if (now >= this.coolDownUntil && now >= this.nextStart) return;
    const start = Math.max(now, this.coolDownUntil, this.nextStart);
    this.nextStart = start + RATE_LIMIT_STAGGER_MS;
    await this.sleepUnlessAborted(start - now, signal);
  }

  /** `sleep`, cut short when the caller cancels (cancel never waits out a
   * cool-down). */
  private async sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.sleep(ms);
    if (signal.aborted) return;
    let onAbort = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(ms), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// ------------------------------------------------------------------ helpers --

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

function parseAndValidate<S extends z.ZodTypeAny>(
  text: string,
  schema: S,
): ParseOutcome<z.output<S>> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, problem: `the response was not valid JSON (${errorMessage(err)})` };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, problem: issues };
  }
  return { ok: true, value: result.data };
}

/** HTTP status of a backend error, when one is attached. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err == null) return undefined;
  const candidate = (err as { status?: unknown; code?: unknown }).status ??
    (err as { status?: unknown; code?: unknown }).code;
  const status = typeof candidate === 'string' ? Number(candidate) : candidate;
  return typeof status === 'number' && Number.isFinite(status) && status >= 100 && status < 600
    ? status
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
