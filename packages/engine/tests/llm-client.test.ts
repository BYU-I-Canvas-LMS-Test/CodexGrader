// StructuredGradingClient behavior against a FAKE modelCall — model calls
// are never made in tests. Covers: request assembly (strict per-call enum
// schema + system prompt + vision parts + knobs), the zod repair retry, the
// transient retry policy (429/5xx/network/timeout/empty responses retry;
// other 4xx and caller cancellation do not), backend-classified failures
// passing through untouched, and stats extraction.

import { describe, expect, it } from 'vitest';
import {
  GradingCallError,
  StructuredGradingClient,
  type ModelCallFn,
  type ModelRequest,
  type ModelResponse,
  type StructuredGradingClientOptions,
} from '../src/llm/structured-client.js';

// ---------------------------------------------------------------- helpers --

type Responder =
  | ModelResponse
  | Error
  | ((params: ModelRequest) => ModelResponse | Promise<ModelResponse>);

/** Queue-based modelCall fake: each call consumes the next responder and
 * records the request (mirrors tests/helpers.ts makeFetch). */
function makeGenerate(responders: Responder[]) {
  const calls: ModelRequest[] = [];
  const queue = [...responders];
  const fn: ModelCallFn = async (params) => {
    calls.push(params);
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected model call #${calls.length}`);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(params);
    return next;
  };
  return { fn, calls };
}

function jsonResponse(body: unknown, usage?: ModelResponse['usage']): ModelResponse {
  return { text: JSON.stringify(body), usage };
}

function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

function makeClient(fn: ModelCallFn, opts: Partial<StructuredGradingClientOptions> = {}) {
  return new StructuredGradingClient({
    modelCall: fn,
    sleep: async () => {},
    random: () => 0,
    ...opts,
  });
}

const criteria = [
  { id: '_4692', ratingIds: ['_817', '_818'] },
  { id: '4', ratingIds: ['blank'] },
];

const validOutput = {
  TotalPoints: '8/10',
  assignmentFeedback: 'Nice work.',
  Rubrics: [{ id: '_4692', ratingID: '_817', points: 8, ratingFeedback: 'Good.' }],
};

function submissionCall(overrides: Record<string, unknown> = {}) {
  return {
    systemPrompt: 'SYS',
    userMessage: 'USER',
    criteria,
    model: 'test-model',
    ...overrides,
  };
}

function userText(params: ModelRequest): string {
  return params.userText;
}

// ------------------------------------------------------------------- tests --

describe('gradeSubmission — request assembly', () => {
  it('sends the strict per-call enum schema, system prompt, vision parts, and knobs', async () => {
    const { fn, calls } = makeGenerate([
      jsonResponse(validOutput, { inputTokens: 100, outputTokens: 50 }),
    ]);
    const client = makeClient(fn);

    const result = await client.gradeSubmission({
      ...submissionCall(),
      images: [{ mimeType: 'image/png', base64: 'QkFTRTY0' }],
      reasoningEffort: 'high',
      maxOutputTokens: 2048,
    });

    expect(result.output).toEqual(validOutput);
    expect(calls).toHaveLength(1);

    const req = calls[0]!;
    expect(req.model).toBe('test-model');
    expect(req.systemPrompt).toBe('SYS');
    expect(req.userText).toBe('USER');
    expect(req.reasoningEffort).toBe('high');
    expect(req.maxOutputTokens).toBe(2048);
    expect(req.signal).toBeInstanceOf(AbortSignal);

    // The silent-drop guard rides on every request, in strict form.
    const schema = req.responseSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties!.Rubrics!.items!.properties!.id!.enum).toEqual(['_4692', '4']);
    expect(schema.properties!.Rubrics!.items!.properties!.ratingID!.enum).toEqual([
      '_817',
      '_818',
      'blank',
    ]);

    // Vision parts in submission order.
    expect(req.images).toEqual([{ mimeType: 'image/png', base64: 'QkFTRTY0' }]);
  });

  it('extracts stats from the backend usage and tolerates its absence', async () => {
    const withUsage = makeGenerate([
      jsonResponse(validOutput, {
        inputTokens: 321,
        outputTokens: 45,
        cachedTokens: 280,
        reasoningTokens: 512,
      }),
    ]);
    const r1 = await makeClient(withUsage.fn).gradeSubmission(submissionCall());
    expect(r1.stats).toMatchObject({
      model: 'test-model',
      promptTokens: 321,
      outputTokens: 45,
      cachedTokens: 280,
      thoughtsTokens: 512,
    });
    expect(r1.stats.durationMs).toBeGreaterThanOrEqual(0);

    const withoutUsage = makeGenerate([{ text: JSON.stringify(validOutput) }]);
    const r2 = await makeClient(withoutUsage.fn).gradeSubmission(submissionCall());
    expect(r2.stats.promptTokens).toBeUndefined();
    expect(r2.stats.outputTokens).toBeUndefined();
    expect(r2.stats.cachedTokens).toBeUndefined();
    expect(r2.stats.thoughtsTokens).toBeUndefined();
    expect(typeof r2.stats.durationMs).toBe('number');
  });
});

describe('gradeSubmission — zod repair retry', () => {
  it('repairs once on validation failure by appending the validation error to the user message', async () => {
    const invalid = { TotalPoints: '8/10', Rubrics: [] }; // assignmentFeedback missing
    const { fn, calls } = makeGenerate([jsonResponse(invalid), jsonResponse(validOutput)]);
    const client = makeClient(fn);

    const result = await client.gradeSubmission(submissionCall());

    expect(result.output).toEqual(validOutput);
    expect(calls).toHaveLength(2);
    const repairText = userText(calls[1]!);
    expect(repairText.startsWith('USER\n\n')).toBe(true);
    expect(repairText).toContain('Your previous response was rejected:');
    expect(repairText).toContain('assignmentFeedback');
  });

  it('repairs malformed (non-JSON) text through the same path', async () => {
    const { fn, calls } = makeGenerate([{ text: 'sorry, no JSON here' }, jsonResponse(validOutput)]);
    const result = await makeClient(fn).gradeSubmission(submissionCall());

    expect(result.output).toEqual(validOutput);
    expect(userText(calls[1]!)).toContain('not valid JSON');
  });

  it('gives up after ONE repair with a non-retryable GradingCallError (deterministic → row ERROR)', async () => {
    const invalid = { TotalPoints: 'eighteen', assignmentFeedback: 'x', Rubrics: [] };
    const { fn, calls } = makeGenerate([jsonResponse(invalid), jsonResponse(invalid)]);

    const err = await makeClient(fn)
      .gradeSubmission(submissionCall())
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(GradingCallError);
    expect((err as GradingCallError).retryable).toBe(false);
    expect((err as GradingCallError).message).toContain('failed validation after a repair attempt');
    expect(calls).toHaveLength(2);
  });
});

describe('gradeSubmission — transient retry policy', () => {
  it('retries a 429 with backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    const { fn, calls } = makeGenerate([httpError(429, 'rate limited'), jsonResponse(validOutput)]);
    const client = makeClient(fn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.gradeSubmission(submissionCall());

    expect(result.output).toEqual(validOutput);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]); // 1s * 2^0 + jitter(random()=0)
  });

  it('backs off exponentially across repeated 5xx, then succeeds', async () => {
    const sleeps: number[] = [];
    const { fn, calls } = makeGenerate([
      httpError(500),
      httpError(503),
      jsonResponse(validOutput),
    ]);
    const client = makeClient(fn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5, // jitter = 250ms
    });

    await client.gradeSubmission(submissionCall());

    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1250, 2250]);
  });

  it('does NOT retry other 4xx — surfaces a non-retryable GradingCallError immediately', async () => {
    const { fn, calls } = makeGenerate([httpError(400, 'bad request')]);

    const err = await makeClient(fn)
      .gradeSubmission(submissionCall())
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(GradingCallError);
    expect((err as GradingCallError).retryable).toBe(false);
    expect((err as GradingCallError).message).toContain('HTTP 400');
    expect((err as GradingCallError).cause).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });

  it('exhausts transient retries into a retryable GradingCallError (engine may re-queue)', async () => {
    const { fn, calls } = makeGenerate([httpError(500), httpError(502), httpError(503)]);

    const err = await makeClient(fn)
      .gradeSubmission(submissionCall())
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(GradingCallError);
    expect((err as GradingCallError).retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('treats network errors (no HTTP status) as transient', async () => {
    const { fn, calls } = makeGenerate([new TypeError('fetch failed'), jsonResponse(validOutput)]);
    const result = await makeClient(fn).gradeSubmission(submissionCall());
    expect(result.output).toEqual(validOutput);
    expect(calls).toHaveLength(2);
  });

  it('re-rolls an empty response and succeeds', async () => {
    const { fn, calls } = makeGenerate([{ text: '' }, {}, jsonResponse(validOutput)]);
    const result = await makeClient(fn).gradeSubmission(submissionCall());
    expect(result.output).toEqual(validOutput);
    expect(calls).toHaveLength(3);
  });

  it('exhausted empty-response re-rolls surface as retryable', async () => {
    const { fn, calls } = makeGenerate([{ text: '' }, { text: ' ' }, { text: '' }]);

    const err = await makeClient(fn)
      .gradeSubmission(submissionCall())
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(GradingCallError);
    expect((err as GradingCallError).retryable).toBe(true);
    expect((err as GradingCallError).message).toContain('empty response');
    expect(calls).toHaveLength(3);
  });

  it('aborts a hung call at the timeout and retries (retryable when exhausted)', async () => {
    // Never resolves; rejects only when the per-attempt signal aborts.
    const hung: ModelCallFn = (params) =>
      new Promise<ModelResponse>((_resolve, reject) => {
        params.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
        );
      });
    const client = makeClient(hung, { timeoutMs: 5 });

    const err = await client
      .gradeSubmission(submissionCall())
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(GradingCallError);
    expect((err as GradingCallError).retryable).toBe(true);
  });

  it('caller cancellation is NOT retryable', async () => {
    const controller = new AbortController();
    const { calls, fn } = makeGenerate([
      (params) =>
        new Promise<ModelResponse>((_resolve, reject) => {
          params.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
          controller.abort(); // the run is cancelled while the call is in flight
        }),
    ]);
    const client = makeClient(fn);

    const err = await client
      .gradeSubmission({ ...submissionCall(), signal: controller.signal })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(GradingCallError);
    expect((err as GradingCallError).retryable).toBe(false);
    expect((err as GradingCallError).message).toContain('cancelled');
    expect(calls).toHaveLength(1);
  });

  it('a pre-cancelled signal never reaches the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fn, calls } = makeGenerate([jsonResponse(validOutput)]);

    const err = await makeClient(fn)
      .gradeSubmission({ ...submissionCall(), signal: controller.signal })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(GradingCallError);
    expect((err as GradingCallError).retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('backend-classified failures', () => {
  it('passes a GradingCallError from the backend through untouched (no retry)', async () => {
    const usageLimit = new GradingCallError('Codex usage limit reached.', {
      retryable: false,
      kind: 'usage_limit',
      resetsAt: '2026-09-24T20:00:00.000Z',
    });
    const { fn, calls } = makeGenerate([usageLimit, jsonResponse(validOutput)]);

    const err = await makeClient(fn)
      .gradeSubmission(submissionCall())
      .then(() => null, (e: unknown) => e);

    expect(err).toBe(usageLimit);
    expect((err as GradingCallError).kind).toBe('usage_limit');
    expect((err as GradingCallError).resetsAt).toBe('2026-09-24T20:00:00.000Z');
    expect(calls).toHaveLength(1);
  });
});

describe('gradeQuizQuestion', () => {
  it('uses the quiz schema and validates the { score, comment } shape', async () => {
    const { fn, calls } = makeGenerate([
      jsonResponse({ score: 4, comment: 'Good detail.' }, { inputTokens: 10 }),
    ]);
    const client = makeClient(fn);

    const result = await client.gradeQuizQuestion({
      systemPrompt: 'QSYS',
      userMessage: 'QUSER',
      model: 'test-model-quiz',
    });

    expect(result.output).toEqual({ score: 4, comment: 'Good detail.' });
    expect(result.stats.model).toBe('test-model-quiz');

    const schema = calls[0]!.responseSchema;
    expect(Object.keys(schema.properties!)).toEqual(['score', 'comment']);
    expect(calls[0]!.systemPrompt).toBe('QSYS');
  });

  it('repairs an out-of-schema quiz grade once', async () => {
    const { fn, calls } = makeGenerate([
      jsonResponse({ score: -1, comment: 'x' }),
      jsonResponse({ score: 0, comment: 'No answer provided.' }),
    ]);

    const result = await makeClient(fn).gradeQuizQuestion({
      systemPrompt: 'QSYS',
      userMessage: 'QUSER',
      model: 'test-model-quiz',
    });

    expect(result.output.score).toBe(0);
    expect(calls).toHaveLength(2);
    expect(userText(calls[1]!)).toContain('Your previous response was rejected:');
  });
});
