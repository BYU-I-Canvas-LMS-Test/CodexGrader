// FakeCodex scenarios end to end: the real backend (locate → probe →
// catalog → quota → exec) spawning the fake CLI, driven through the engine's
// own StructuredGradingClient — so retries, repair, and the typed failures
// that pause a run are exercised exactly as in production.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GradingCallError, StructuredGradingClient } from '@aigrader/engine';
import { createCodexBackend, type CodexBackend } from '../src/backend.js';
import { UNTRUSTED_CONTENT_CLAUSE } from '../src/model-call.js';

const FAKE = fileURLToPath(new URL('./fake-codex/fake-codex.mjs', import.meta.url));
const COMMAND = { command: process.execPath, prefixArgs: [FAKE] };

/** A GraderOutput with no rubric (criteria: []) — schema-valid. */
const ANSWER = JSON.stringify({ TotalPoints: '18/20', assignmentFeedback: 'Solid work.', Rubrics: [] });

let work: string;
let fakeDir: string;
let tempRoot: string;
const saved = { ...process.env };

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'aigrader-codex-test-'));
  fakeDir = join(work, 'fake');
  tempRoot = join(work, 'calls');
  process.env.FAKE_CODEX_DIR = fakeDir;
  process.env.FAKE_CODEX_ANSWER = ANSWER;
  delete process.env.FAKE_CODEX_SCENARIO;
  delete process.env.FAKE_CODEX_LOGGED_OUT;
  delete process.env.FAKE_CODEX_OMIT_FLAGS;
  delete process.env.FAKE_CODEX_USAGE;
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(work, { recursive: true, force: true });
});

function backend(extra: Partial<Parameters<typeof createCodexBackend>[0]> = {}): CodexBackend {
  return createCodexBackend({
    command: COMMAND,
    stateDir: join(work, 'state'),
    tempRoot,
    callTimeoutMs: 20_000,
    ...extra,
  });
}

function client(b: CodexBackend, maxAttempts = 3) {
  return new StructuredGradingClient({ modelCall: b.modelCall, sleep: async () => {}, maxAttempts });
}

const grade = (b: CodexBackend, overrides: Record<string, unknown> = {}, maxAttempts = 3) =>
  client(b, maxAttempts).gradeSubmission({
    systemPrompt: 'CALIBRATED SYSTEM PROMPT',
    userMessage: 'Student submission: the mitochondria is the powerhouse of the cell.',
    criteria: [],
    model: '',
    reasoningEffort: 'medium',
    ...overrides,
  });

function calls(): Array<Record<string, unknown> & { argv: string[] }> {
  const file = join(fakeDir, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown> & { argv: string[] });
}

describe('startup', () => {
  it('probes Codex, disables every non-safe feature, and prepares a tool-free catalog', async () => {
    const b = backend();
    const status = await b.ready;
    expect(status).toMatchObject({
      state: 'ready',
      version: '0.155.0-fake',
      login: 'chatgpt',
      defaultModel: 'gpt-fake-sol',
      models: ['gpt-fake-sol', 'gpt-fake-luna'],
      catalogSource: 'live',
    });
    const catalog = JSON.parse(readFileSync(join(work, 'state', 'worker-catalog.json'), 'utf8')) as { models: Record<string, unknown>[] };
    for (const m of catalog.models) {
      expect(m).not.toHaveProperty('tool_mode');
      expect(m).not.toHaveProperty('multi_agent_version');
      expect(m.supports_search_tool).toBe(false);
    }
  });

  it('reports signed-out, too-old, and missing Codex in plain English — and pauses (auth) instead of erroring', async () => {
    process.env.FAKE_CODEX_LOGGED_OUT = '1';
    const signedOut = backend();
    expect((await signedOut.ready).state).toBe('logged_out');
    await expect(grade(signedOut)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/codex login/) });

    delete process.env.FAKE_CODEX_LOGGED_OUT;
    process.env.FAKE_CODEX_OMIT_FLAGS = '--ephemeral,--output-schema';
    const old = backend();
    const oldStatus = await old.ready;
    expect(oldStatus.state).toBe('unsupported');
    expect(oldStatus.message).toMatch(/--ephemeral, --output-schema/);

    const nowhere = join(work, 'nope', 'codex.exe');
    const missing = createCodexBackend({ codexPath: nowhere, stateDir: work, searchPaths: [nowhere] });
    const missingStatus = await missing.ready;
    expect(['not_found']).toContain(missingStatus.state);
    await expect(grade(missing)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('signing in and resuming works without a restart (re-probe on the next call)', async () => {
    process.env.FAKE_CODEX_LOGGED_OUT = '1';
    const b = backend();
    await expect(grade(b)).rejects.toMatchObject({ kind: 'auth' });
    delete process.env.FAKE_CODEX_LOGGED_OUT; // the teacher ran `codex login`
    await expect(grade(b)).resolves.toMatchObject({ output: { TotalPoints: '18/20' } });
  });

  it('resolveModel keeps an available choice and falls back from an unavailable one', async () => {
    const b = backend();
    await b.ready;
    expect(b.resolveModel('gpt-fake-luna')).toEqual({ model: 'gpt-fake-luna', note: null });
    expect(b.resolveModel('gpt-6-astra')).toMatchObject({ model: 'gpt-fake-sol', note: expect.stringContaining('not available') });
    expect(b.resolveModel(undefined)).toEqual({ model: 'gpt-fake-sol', note: null });
  });
});

describe('a grading call', () => {
  it('runs one isolated exec: calibrated prompt + clause, stdin message, empty cwd, strict flags, default model', async () => {
    const b = backend();
    const result = await grade(b, {
      images: [
        { mimeType: 'image/png', base64: Buffer.from('png-bytes').toString('base64') },
        { mimeType: 'image/webp', base64: Buffer.from('webp!').toString('base64') },
      ],
    });
    expect(result.output).toMatchObject({ TotalPoints: '18/20', assignmentFeedback: 'Solid work.' });
    expect(result.stats).toMatchObject({ promptTokens: 131, outputTokens: 40 });

    const [call] = calls();
    expect(call!.system).toBe(`CALIBRATED SYSTEM PROMPT${UNTRUSTED_CONTENT_CLAUSE}`);
    expect(call!.stdin).toContain('mitochondria');
    expect(call!.cwdEmpty).toBe(true);
    expect(call!.images).toEqual([
      { file: 'image-01.png', bytes: 9 },
      { file: 'image-02.webp', bytes: 5 },
    ]);
    const argv = call!.argv;
    for (const flag of ['--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json']) expect(argv).toContain(flag);
    expect(argv.join(' ')).toContain('--model gpt-fake-sol');
    expect(argv.join(' ')).toContain('model_reasoning_effort="medium"');
    expect(argv.some((a) => a.startsWith('model_catalog_json='))).toBe(true);
    const disabled = argv.flatMap((a, i) => (a === '--disable' ? [argv[i + 1]] : []));
    expect(disabled.sort()).toEqual(['apps', 'browser_use', 'multi_agent', 'shell_tool', 'some_future_tool', 'view_image']);
    expect(call!.schema).toMatchObject({ type: 'object', additionalProperties: false });

    // Nothing left behind: the per-call folder is gone.
    expect(existsSync(tempRoot) ? readdirSync(tempRoot) : []).toEqual([]);
  });

  it('usage limit → usage_limit with the reset time (the run pauses and auto-resumes)', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'usage_limit';
    const err = await grade(backend()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GradingCallError);
    expect(err).toMatchObject({ kind: 'usage_limit' });
    const resetsAt = Date.parse((err as GradingCallError).resetsAt!);
    expect(resetsAt - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(calls()).toHaveLength(1); // never retried
  });

  it('usage limit without a reset time asks the app-server for one', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'usage_limit_noreset';
    process.env.FAKE_CODEX_USAGE = JSON.stringify({ primary: 99, secondary: 20 });
    const b = backend({ stopPercent: 101 }); // don't pre-empt; let Codex report it
    const err = (await grade(b).catch((e: unknown) => e)) as GradingCallError;
    expect(err.kind).toBe('usage_limit');
    const hours = (Date.parse(err.resetsAt!) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.9);
    expect(hours).toBeLessThan(1.1); // the 5-hour window's reset, not the weekly one
  });

  it('grading pauses BEFORE running out: at 85% of a window no exec is started', async () => {
    process.env.FAKE_CODEX_USAGE = JSON.stringify({ primary: 10, secondary: 88 });
    const err = (await grade(backend()).catch((e: unknown) => e)) as GradingCallError;
    expect(err.kind).toBe('usage_limit');
    expect(err.message).toMatch(/weekly Codex usage is at 88%/);
    expect(calls()).toHaveLength(0);
  });

  it('transient failures retry (server error, short rate limit, crash) and then succeed', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'server_error,rate_limited,crash,success';
    const result = await grade(backend(), {}, 4);
    expect(result.output.TotalPoints).toBe('18/20');
    expect(calls().map((c) => c.scenario)).toEqual(['server_error', 'rate_limited', 'crash', 'success']);
  });

  it('an unparseable answer gets one repair retry', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'invalid_json,success';
    await expect(grade(backend())).resolves.toMatchObject({ output: { TotalPoints: '18/20' } });
    expect(calls()).toHaveLength(2);
  });

  it.each([
    ['auth', 'auth'],
    ['model', 'model_unavailable'],
    ['refusal', 'refusal'],
  ])('%s → kind %s, never retried', async (scenario, kind) => {
    process.env.FAKE_CODEX_SCENARIO = scenario;
    await expect(grade(backend())).rejects.toMatchObject({ kind });
    expect(calls()).toHaveLength(1);
  });

  it('too large and tool use → a row error, never retried', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'too_large';
    await expect(grade(backend())).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/too large/) });
    rmSync(fakeDir, { recursive: true, force: true });
    process.env.FAKE_CODEX_SCENARIO = 'tool_breach';
    await expect(grade(backend())).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/tried to use a tool/) });
    expect(calls()).toHaveLength(1);
  });

  it('a hung call is killed at the timeout; cancelling kills it at once', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'hang';
    const quick = backend({ callTimeoutMs: 1_500 });
    const started = Date.now();
    await expect(grade(quick, {}, 1)).rejects.toBeInstanceOf(GradingCallError);
    expect(Date.now() - started).toBeLessThan(10_000);

    const controller = new AbortController();
    const pending = grade(backend(), { signal: controller.signal }, 1);
    setTimeout(() => controller.abort(), 800);
    const t0 = Date.now();
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/cancelled/) });
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(existsSync(tempRoot) ? readdirSync(tempRoot) : []).toEqual([]);
  }, 30_000);
});
