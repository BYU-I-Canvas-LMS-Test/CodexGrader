#!/usr/bin/env node
// FakeCodex — a stand-in for the Codex CLI in tests. It imitates the
// subcommands AI Grader uses, with outputs shaped like Codex 0.155's real
// ones (captured during the Phase 3 spike), and records every call.
//
// Environment:
//   FAKE_CODEX_DIR        folder for calls.jsonl (argv, stdin, images) + state
//   FAKE_CODEX_SCENARIO   comma list of exec outcomes, consumed per call; the
//                         last repeats. success | invalid_json | empty |
//                         usage_limit | usage_limit_noreset | auth | model |
//                         server_error | rate_limited | refusal | too_large |
//                         hang | crash | tool_breach
//   FAKE_CODEX_ANSWER     JSON text returned on success
//   FAKE_CODEX_LOGGED_OUT "1" ⇒ `login status` says not logged in
//   FAKE_CODEX_OMIT_FLAGS comma list of exec flags to leave out of --help
//   FAKE_CODEX_USAGE      JSON {primary, secondary} usedPercent overrides

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const dir = env.FAKE_CODEX_DIR;
const argv = process.argv.slice(2);
if (dir) mkdirSync(dir, { recursive: true });

const out = (s) => process.stdout.write(s);
const line = (obj) => out(`${JSON.stringify(obj)}\n`);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function nextScenario() {
  const list = (env.FAKE_CODEX_SCENARIO || 'success').split(',').map((s) => s.trim()).filter(Boolean);
  let n = 0;
  const counter = dir ? join(dir, 'exec-count') : null;
  if (counter && existsSync(counter)) n = Number(readFileSync(counter, 'utf8')) || 0;
  if (counter) writeFileSync(counter, String(n + 1));
  return list[Math.min(n, list.length - 1)];
}

function valueAfter(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function allAfter(flag) {
  const values = [];
  argv.forEach((a, i) => {
    if (a === flag) values.push(argv[i + 1]);
  });
  return values;
}

const EXEC_FLAGS = [
  '--config', '--enable', '--disable', '--strict-config', '--image', '--model', '--oss', '--profile', '--sandbox',
  '--cd', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema',
  '--color', '--json', '--output-last-message', '--help', '--version',
];

const cmd = argv[0];

if (cmd === '--version') {
  out('codex-cli 0.155.0-fake\n');
  process.exit(0);
}

if (cmd === 'exec' && argv.includes('--help')) {
  const omit = new Set((env.FAKE_CODEX_OMIT_FLAGS || '').split(',').filter(Boolean));
  out('Run Codex non-interactively\n\nOptions:\n');
  for (const f of EXEC_FLAGS) if (!omit.has(f)) out(`      ${f} <X>\n          help text\n`);
  process.exit(0);
}

if (cmd === 'features' && argv[1] === 'list') {
  const rows = [
    ['apps', 'stable', true],
    ['browser_use', 'stable', true],
    ['collaboration_modes', 'removed', true],
    ['content_item_kinds', 'stable', true],
    ['memories', 'stable', false],
    ['multi_agent', 'stable', true],
    ['secret_auth_storage', 'stable', true],
    ['shell_tool', 'stable', true],
    ['some_future_tool', 'under development', true],
    ['view_image', 'stable', true],
  ];
  for (const [name, stage, on] of rows) out(`${name.padEnd(40)} ${stage.padEnd(18)} ${on}\n`);
  process.exit(0);
}

if (cmd === 'login' && argv[1] === 'status') {
  out(env.FAKE_CODEX_LOGGED_OUT === '1' ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
  process.exit(0);
}

if (cmd === 'debug' && argv[1] === 'models') {
  const bundled = argv.includes('--bundled');
  const model = (slug, visibility, priority) => ({
    slug,
    display_name: slug,
    visibility,
    priority,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
    input_modalities: ['text', 'image'],
    tool_mode: 'code_mode_only',
    multi_agent_version: 'v2',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    supports_search_tool: true,
    experimental_supported_tools: ['clock'],
    base_instructions: 'You are Codex.',
  });
  line({
    models: bundled
      ? [model('gpt-bundled-only', 'list', 1)]
      : [model('gpt-hidden', 'hide', 1), model('gpt-fake-sol', 'list', 4), model('gpt-fake-luna', 'list', 6)],
  });
  process.exit(0);
}

if (cmd === 'app-server') {
  const usage = JSON.parse(env.FAKE_CODEX_USAGE || '{}');
  const rl = createInterface({ input: process.stdin });
  const now = Math.floor(Date.now() / 1000);
  rl.on('line', (text) => {
    const msg = JSON.parse(text);
    if (msg.method === 'initialize') line({ id: msg.id, result: { userAgent: 'fake', codexHome: 'x' } });
    if (msg.method === 'account/rateLimits/read') {
      const snap = {
        limitId: 'codex',
        primary: { usedPercent: usage.primary ?? 10, windowDurationMins: 300, resetsAt: now + 3600 },
        secondary: { usedPercent: usage.secondary ?? 20, windowDurationMins: 10080, resetsAt: now + 86400 },
        planType: 'edu',
      };
      line({ id: msg.id, result: { ordinaryUsageAllowed: usage.allowed ?? true, rateLimits: snap, rateLimitsByLimitId: { codex: snap } } });
    }
  });
  setInterval(() => {}, 1000);
} else if (cmd === 'exec') {
  const stdin = readStdin();
  const cwd = valueAfter('--cd');
  const images = allAfter('--image').map((p) => ({ file: p.split(/[\\/]/).pop(), bytes: existsSync(p) ? statSync(p).size : -1 }));
  const outFile = valueAfter('--output-last-message');
  const schemaFile = valueAfter('--output-schema');
  const systemFileArg = argv.find((a) => a.startsWith('model_instructions_file='));
  const systemFile = systemFileArg ? JSON.parse(systemFileArg.slice('model_instructions_file='.length)) : null;
  const scenario = nextScenario();
  if (dir) {
    appendFileSync(
      join(dir, 'calls.jsonl'),
      `${JSON.stringify({
        argv,
        stdin,
        scenario,
        images,
        cwdEmpty: cwd && existsSync(cwd) ? readdirSync(cwd).length === 0 : null,
        system: systemFile && existsSync(systemFile) ? readFileSync(systemFile, 'utf8') : null,
        schema: schemaFile && existsSync(schemaFile) ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null,
        processCwd: process.cwd(),
      })}\n`,
    );
  }
  const answer = env.FAKE_CODEX_ANSWER || '{"ok":true}';
  const fail = (message, code = 1) => {
    line({ type: 'thread.started', thread_id: 't1' });
    line({ type: 'turn.started' });
    line({ type: 'error', message });
    line({ type: 'turn.failed', error: { message } });
    process.exit(code);
  };
  const succeed = (text, extraItems = []) => {
    if (outFile) writeFileSync(outFile, text);
    line({ type: 'thread.started', thread_id: 't1' });
    line({ type: 'turn.started' });
    for (const item of extraItems) line({ type: 'item.completed', item });
    line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
    line({ type: 'turn.completed', usage: { input_tokens: 131, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 7 } });
    process.exit(0);
  };
  const reset = Math.floor(Date.now() / 1000) + 3600;
  switch (scenario) {
    case 'success':
      succeed(answer);
      break;
    case 'invalid_json':
      succeed('this is not json');
      break;
    case 'empty':
      succeed('');
      break;
    case 'usage_limit':
      fail(JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', message: "You've hit your usage limit.", resets_at: reset } }));
      break;
    case 'usage_limit_noreset':
      fail("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.");
      break;
    case 'auth':
      fail(JSON.stringify({ type: 'error', status: 401, error: { type: 'unauthorized', message: 'Your access token could not be refreshed. Please log in again.' } }));
      break;
    case 'model':
      fail(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." } }));
      break;
    case 'server_error':
      fail('stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)');
      break;
    case 'rate_limited':
      fail(JSON.stringify({ type: 'error', status: 429, error: { type: 'rate_limit_exceeded', message: 'Rate limit exceeded. Please retry shortly.' } }));
      break;
    case 'refusal':
      fail(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'This request was flagged under the cyber policy.' } }));
      break;
    case 'too_large':
      fail(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'Your input exceeds the context window of this model.' } }));
      break;
    case 'hang':
      setInterval(() => {}, 1000);
      break;
    case 'crash':
      process.stderr.write('thread main panicked at core/src/lib.rs\n');
      process.exit(101);
      break;
    case 'tool_breach':
      succeed(answer, [{ id: 'item_x', type: 'command_execution', command: 'dir' }]);
      break;
    default:
      fail(`unknown scenario ${scenario}`);
  }
} else {
  process.stderr.write(`fake codex: unsupported ${argv.join(' ')}\n`);
  process.exit(2);
}
