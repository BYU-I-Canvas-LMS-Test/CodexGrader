// Pure pieces of the Codex backend: the worker command line, event parsing,
// the error classifier (fed the real error shapes captured from Codex
// 0.155), capability parsing, catalog sanitizing, the locator, and the
// quota guard.

import { describe, expect, it } from 'vitest';
import { GradingCallError } from '@aigrader/engine';
import { buildExecArgs, tomlString } from '../src/args.js';
import {
  featuresToDisable,
  parseExecFlags,
  parseFeatures,
  parseLoginStatus,
  parseVersion,
} from '../src/capabilities.js';
import { sanitizeCatalog, summarizeCatalog } from '../src/catalog.js';
import { classifyFailure, toThrowable } from '../src/errors.js';
import { parseExecEvents } from '../src/events.js';
import { codexCandidates } from '../src/locator.js';
import type { RunResult } from '../src/process.js';
import { QuotaGuard, parseRateLimits, type UsageSnapshot } from '../src/rate-limits.js';

const ARGS = {
  cwd: 'C:\\T\\aigrader-1\\cwd',
  systemFile: 'C:\\T\\aigrader-1\\system.md',
  schemaFile: 'C:\\T\\aigrader-1\\schema.json',
  outFile: 'C:\\T\\aigrader-1\\answer.json',
  catalogFile: "C:\\Users\\O'Brien\\.aigrader\\state\\codex\\worker-catalog.json",
  model: 'gpt-5.6-sol',
  reasoningEffort: 'medium',
  images: ['C:\\T\\aigrader-1\\image-01.png', 'C:\\T\\aigrader-1\\image-02.gif'],
  disableFeatures: ['apps', 'shell_tool'],
};

describe('worker command line', () => {
  const args = buildExecArgs(ARGS);
  const joined = args.join(' ');

  it('carries every isolation switch', () => {
    for (const flag of ['--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json']) {
      expect(args).toContain(flag);
    }
    expect(joined).toContain('--sandbox read-only');
    expect(joined).toContain('approval_policy="never"');
    for (const key of [
      'web_search="disabled"',
      'tools.web_search={enabled=false}',
      'tools.experimental_request_user_input={enabled=false}',
      'tools.update_plan={enabled=false}',
      'include_environment_context=false',
      'include_permissions_instructions=false',
      'include_apps_instructions=false',
      'include_collaboration_mode_instructions=false',
      'project_doc_max_bytes=0',
      'skills.include_instructions=false',
      'skills.bundled.enabled=false',
    ]) {
      expect(args).toContain(key);
    }
    expect(joined).toContain('root_agent_usage_hint_text=""');
    expect(joined).toContain('--disable apps --disable shell_tool');
  });

  it('passes files as TOML strings (Windows backslashes and apostrophes survive)', () => {
    expect(args).toContain(`model_instructions_file=${JSON.stringify(ARGS.systemFile)}`);
    expect(args).toContain(`model_catalog_json=${JSON.stringify(ARGS.catalogFile)}`);
    expect(tomlString('C:\\a"b')).toBe('"C:\\\\a\\"b"');
  });

  it('orders images, then schema/output, and reads the prompt from stdin', () => {
    expect(args.indexOf(ARGS.images[0]!)).toBeLessThan(args.indexOf(ARGS.images[1]!));
    expect(args.slice(-6)).toEqual(['--output-schema', ARGS.schemaFile, '--output-last-message', ARGS.outFile, '--json', '-']);
    expect(joined).toContain('--model gpt-5.6-sol');
  });

  it('omits model/effort/catalog when not given', () => {
    const bare = buildExecArgs({ ...ARGS, model: undefined, reasoningEffort: undefined, catalogFile: null });
    expect(bare.join(' ')).not.toMatch(/--model|model_reasoning_effort|model_catalog_json/);
  });
});

describe('event stream', () => {
  it('collects the answer and usage (real 0.155 shapes)', () => {
    const outcome = parseExecEvents(
      [
        '{"type":"thread.started","thread_id":"01a0"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable because code-mode host is disabled."}}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"score\\":0}"}}',
        '{"type":"turn.completed","usage":{"input_tokens":131,"cached_input_tokens":3,"output_tokens":40,"reasoning_output_tokens":7}}',
        'not json',
      ].join('\n'),
    );
    expect(outcome).toMatchObject({
      agentText: '{"score":0}',
      completed: true,
      failed: false,
      errors: [],
      toolItems: [],
      usage: { inputTokens: 131, cachedTokens: 3, outputTokens: 40, reasoningTokens: 7 },
    });
  });

  it('flags any tool use', () => {
    const outcome = parseExecEvents('{"type":"item.started","item":{"type":"command_execution"}}\n{"type":"item.completed","item":{"type":"web_search"}}');
    expect(outcome.toolItems).toEqual(['command_execution', 'web_search']);
  });
});

const run = (overrides: Partial<RunResult> = {}): RunResult => ({
  exitCode: 1,
  signal: null,
  stdout: '',
  stderr: '',
  stoppedBy: null,
  spawnError: null,
  durationMs: 10,
  ...overrides,
});
const failed = (message: string) => parseExecEvents(`{"type":"turn.failed","error":{"message":${JSON.stringify(message)}}}`);

describe('error classifier', () => {
  it('model not available on the plan (captured verbatim)', () => {
    const info = classifyFailure({
      run: run(),
      outcome: failed('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account."}}'),
    });
    expect(info).toMatchObject({ kind: 'model_unavailable', retryable: false, status: 400 });
    expect(info.message).toContain('not supported');
  });

  it('usage limit with a reset time → usage_limit + resetsAt', () => {
    const at = Math.floor(Date.parse('2026-09-25T03:00:00Z') / 1000);
    const info = classifyFailure({
      run: run(),
      outcome: failed(JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', message: "You've hit your usage limit.", resets_at: at } })),
    });
    expect(info).toMatchObject({ kind: 'usage_limit', resetsAt: '2026-09-25T03:00:00.000Z' });
  });

  it('usage limit in words, and workspace credit depletion', () => {
    expect(classifyFailure({ run: run(), outcome: failed("You've hit your usage limit. Try again later.") }).kind).toBe('usage_limit');
    expect(classifyFailure({ run: run(), outcome: failed('{"status":402,"error":{"type":"workspace_member_credits_depleted","message":"x"}}') }).kind).toBe('usage_limit');
  });

  it('a plain 429 is a short-term rate limit → transient retry', () => {
    const info = classifyFailure({ run: run(), outcome: failed('{"status":429,"error":{"type":"rate_limit_exceeded","message":"Rate limit exceeded."}}') });
    expect(info).toMatchObject({ retryable: true, status: 429 });
    expect(info.kind).toBeUndefined();
  });

  it('auth, refusal, too large, network, crash, timeout, missing binary, tool use', () => {
    expect(classifyFailure({ run: run(), outcome: failed('{"status":401,"error":{"message":"Please log in again."}}') }).kind).toBe('auth');
    expect(classifyFailure({ run: run(), outcome: failed('{"status":400,"error":{"message":"flagged under the cyber policy"}}') }).kind).toBe('refusal');
    const tooLarge = classifyFailure({ run: run(), outcome: failed('{"status":400,"error":{"message":"input exceeds the context window"}}') });
    expect(tooLarge.retryable).toBe(false);
    expect(tooLarge.kind).toBeUndefined();
    expect(classifyFailure({ run: run(), outcome: failed('stream disconnected before completion: error sending request') })).toMatchObject({ retryable: true });
    expect(classifyFailure({ run: run({ exitCode: 101, stderr: 'panicked' }), outcome: parseExecEvents('') })).toMatchObject({ retryable: true });
    expect(classifyFailure({ run: run({ stoppedBy: 'timeout' }), outcome: parseExecEvents('') })).toMatchObject({ retryable: true });
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    expect(classifyFailure({ run: run({ spawnError: missing }), outcome: parseExecEvents('') })).toMatchObject({ kind: 'auth' });
    expect(
      classifyFailure({ run: run({ exitCode: 0 }), outcome: parseExecEvents('{"type":"item.completed","item":{"type":"command_execution"}}') }),
    ).toMatchObject({ retryable: false });
  });

  it('toThrowable: typed/non-retryable → GradingCallError; transient → Error with status', () => {
    const typed = toThrowable({ kind: 'usage_limit', retryable: false, message: 'm', resetsAt: 'r' });
    expect(typed).toBeInstanceOf(GradingCallError);
    expect(typed).toMatchObject({ kind: 'usage_limit', resetsAt: 'r', retryable: false });
    const transient = toThrowable({ retryable: true, status: 503, message: 'down' });
    expect(transient).not.toBeInstanceOf(GradingCallError);
    expect((transient as Error & { status?: number }).status).toBe(503);
  });
});

describe('capabilities', () => {
  it('parses version, flags, features, and login', () => {
    expect(parseVersion('codex-cli 0.155.0-alpha.16.3')).toBe('0.155.0-alpha.16.3');
    expect(parseVersion('hello')).toBeNull();
    expect(parseExecFlags('  --ephemeral\n      --output-schema <FILE>\n  -o, --output-last-message')).toEqual(
      new Set(['--ephemeral', '--output-schema', '--output-last-message']),
    );
    const features = parseFeatures(
      'apps                                     stable             true\n' +
        'code_mode                                under development  false\n' +
        'collaboration_modes                      removed            true\n' +
        'content_item_kinds                       stable             true\n' +
        'guardianv2.thread_context                under development  false\n' +
        'brand_new_tool                           under development  true\n',
    );
    expect(features).toHaveLength(6);
    expect(featuresToDisable(features)).toEqual(['apps', 'brand_new_tool']);
    expect(parseLoginStatus('Logged in using ChatGPT')).toBe('chatgpt');
    expect(parseLoginStatus('Not logged in')).toBe('logged_out');
  });
});

describe('worker catalog', () => {
  const raw = {
    models: [
      { slug: 'gpt-reserve', visibility: 'hide', priority: 3, tool_mode: 'code_mode_only', multi_agent_version: 'v1' },
      { slug: 'gpt-5.6-sol', visibility: 'list', priority: 4, tool_mode: 'code_mode_only', multi_agent_version: 'v2', apply_patch_tool_type: 'freeform', web_search_tool_type: 'text', supports_search_tool: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }], input_modalities: ['text', 'image'] },
      { slug: 'gpt-5.5', visibility: 'list', priority: 7 },
    ],
  };

  it('strips every tool field and extra instructions', () => {
    const clean = sanitizeCatalog(raw);
    for (const m of clean.models) {
      for (const field of ['tool_mode', 'multi_agent_version', 'apply_patch_tool_type', 'web_search_tool_type']) {
        expect(m).not.toHaveProperty(field);
      }
      expect(m).toMatchObject({ supports_search_tool: false, experimental_supported_tools: [], node_repl_disabled: true, include_skills_usage_instructions: false });
    }
    expect(raw.models[1]).toHaveProperty('tool_mode'); // input untouched
  });

  it('the default model is the first LISTED one by priority', () => {
    const summary = summarizeCatalog(sanitizeCatalog(raw));
    expect(summary.defaultModel).toBe('gpt-5.6-sol');
    expect(summary.models.find((m) => m.slug === 'gpt-5.6-sol')).toMatchObject({ reasoningLevels: ['low', 'max'], acceptsImages: true, listed: true });
  });
});

describe('locator', () => {
  it('Windows: CODEX_PATH, PATH, the desktop app, then npm', () => {
    const list = codexCandidates({
      codexPath: 'D:\\tools\\codex.exe',
      platform: 'win32',
      env: { PATH: 'C:\\bin', LOCALAPPDATA: 'C:\\U\\AppData\\Local', APPDATA: 'C:\\U\\AppData\\Roaming' },
      home: 'C:\\U',
    });
    expect(list[0]).toEqual({ path: 'D:\\tools\\codex.exe', source: 'CODEX_PATH' });
    expect(list[1]!.source).toBe('PATH');
    expect(list[1]!.path).toMatch(/codex\.exe$/);
  });

  it('macOS: the app bundle and Homebrew are searched', () => {
    const paths = codexCandidates({ platform: 'darwin', env: { PATH: '' }, home: '/Users/t' }).map((c) => c.path);
    expect(paths).toContain('/Applications/Codex.app/Contents/Resources/codex');
    expect(paths).toContain('/opt/homebrew/bin/codex');
  });
});

describe('quota guard', () => {
  const snap = (primary: number, secondary: number, allowed: boolean | null = true): UsageSnapshot =>
    parseRateLimits({
      ordinaryUsageAllowed: allowed,
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1_790_327_222 },
          secondary: { usedPercent: secondary, windowDurationMins: 10080, resetsAt: 1_790_367_506 },
          planType: 'edu',
        },
      },
    })!;

  it('parses the real account/rateLimits/read shape', () => {
    const s = snap(5, 66);
    expect(s.windows).toEqual([
      { name: 'primary', usedPercent: 5, windowMinutes: 300, resetsAt: new Date(1_790_327_222_000).toISOString() },
      { name: 'secondary', usedPercent: 66, windowMinutes: 10080, resetsAt: new Date(1_790_367_506_000).toISOString() },
    ]);
    expect(s.planType).toBe('edu');
  });

  it('lets grading run under the threshold and pauses at it, resuming at the reset', async () => {
    let current = snap(5, 66);
    const guard = new QuotaGuard({ read: async () => current, ttlMs: 0 });
    await expect(guard.check()).resolves.toBeUndefined();
    current = snap(5, 86);
    const err = await guard.check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GradingCallError);
    expect(err).toMatchObject({ kind: 'usage_limit', resetsAt: new Date(1_790_367_506_000).toISOString() });
    expect((err as Error).message).toMatch(/weekly Codex usage is at 86%/);
  });

  it('waits for the LATER reset when both windows are over, and honors allowed=false', async () => {
    const both = new QuotaGuard({ read: async () => snap(95, 90), ttlMs: 0 });
    await expect(both.check()).rejects.toMatchObject({ resetsAt: new Date(1_790_367_506_000).toISOString() });
    const blocked = new QuotaGuard({ read: async () => snap(1, 1, false), ttlMs: 0 });
    await expect(blocked.check()).rejects.toMatchObject({ kind: 'usage_limit' });
  });

  it('unknown usage never blocks grading; reads are cached', async () => {
    let reads = 0;
    const guard = new QuotaGuard({ read: async () => (reads++, null), ttlMs: 60_000 });
    await guard.check();
    await guard.check();
    expect(reads).toBe(1);
  });
});
