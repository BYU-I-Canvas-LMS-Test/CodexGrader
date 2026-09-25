// The `aigrader` command (Phase 2 subset):
//
//   aigrader serve [--detach] [--port N] [--env-file PATH]
//       Run the local server (foreground), or start it in the background and
//       return once it is ready (--detach — what the Codex shim does).
//   aigrader open [PATH]
//       Start the server if needed and open the review page in the browser
//       (a fresh single-use login link; the link itself is never printed).
//   aigrader status     Is it running? Which Canvas instances are set up?
//   aigrader stop       Checkpoint every run and stop the server.
//   aigrader version
//
// Phase 5 adds: mcp, setup, doctor, config, update, uninstall.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AlreadyRunningError, ControlUnavailableError, connectControl, type ControlResponse } from './control.js';
import { createFileLogger } from './logger.js';
import { resolvePaths, type AigraderPaths } from './paths.js';
import { startServer } from './server.js';
import { readVersion } from './version.js';

const USAGE = `Usage: aigrader <command>

  serve [--detach] [--port N]   Run the AI Grader server
  open [PATH]                   Open the review page in your browser
  status                        Show whether the server is running
  stop                          Stop the server (runs resume next time)
  version                       Print the version
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: CliIo = {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
};

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      else if (['port', 'env-file'].includes(arg.slice(2)) && rest[i + 1] !== undefined) flags.set(arg.slice(2), rest[++i]!);
      else flags.set(arg.slice(2), true);
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  const envFile = typeof flags.get('env-file') === 'string' ? (flags.get('env-file') as string) : undefined;
  const paths = resolvePaths({ envFile });
  const version = readVersion();

  switch (command) {
    case 'serve':
      return flags.has('detach') ? serveDetached(paths, argv, io) : serveForeground(paths, version, flags, io);
    case 'open':
      return openReview(paths, argv, positional[0] ?? '/', io);
    case 'status':
      return status(paths, io);
    case 'stop':
      return stop(paths, io);
    case 'version':
    case '--version':
      io.out(version);
      return 0;
    case 'help':
    case '--help':
      io.out(USAGE);
      return 0;
    default:
      io.err(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

async function serveForeground(
  paths: AigraderPaths,
  version: string,
  flags: Map<string, string | true>,
  io: CliIo,
): Promise<number> {
  const portFlag = flags.get('port');
  const port = typeof portFlag === 'string' ? Number(portFlag) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    io.err('--port must be a number from 0 to 65535.');
    return 2;
  }
  const log = createFileLogger(paths.logsDir, { echo: process.stderr.isTTY === true });
  try {
    const server = await startServer({ paths, version, port, log, handleSignals: true });
    io.out(`AI Grader ${version} is running at ${server.origin}`);
    const reason = await server.stopped;
    return reason === 'signal' || reason === 'idle' || reason === 'requested' ? 0 : 1;
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      io.out('AI Grader is already running.');
      return 0;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`[server] Could not start: ${message}`);
    io.err(`AI Grader could not start: ${message}`);
    return 1;
  }
}

/** The script path to re-run for a detached server (bin/aigrader.mjs). */
function binScript(): string {
  return fileURLToPath(new URL('../bin/aigrader.mjs', import.meta.url));
}

/** Starts a detached server and waits until it answers (or times out). */
export async function ensureServer(
  paths: AigraderPaths,
  argv: string[] = [],
  timeoutMs = 30_000,
): Promise<ControlResponse> {
  try {
    const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
    client.close();
    if (client.hello.ready) return client.hello;
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) throw err;
    const passthrough = envFileArgs(argv);
    const child = spawn(process.execPath, [binScript(), 'serve', ...passthrough], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
      client.close();
      if (client.hello.ready) return client.hello;
    } catch {
      // still starting
    }
  }
  throw new Error(
    `AI Grader did not start within ${Math.round(timeoutMs / 1000)} seconds. See ${paths.logsDir} for details.`,
  );
}

function envFileArgs(argv: string[]): string[] {
  const i = argv.findIndex((a) => a === '--env-file' || a.startsWith('--env-file='));
  if (i < 0) return [];
  return argv[i]!.includes('=') ? [argv[i]!] : [argv[i]!, argv[i + 1] ?? ''];
}

async function serveDetached(paths: AigraderPaths, argv: string[], io: CliIo): Promise<number> {
  try {
    const hello = await ensureServer(paths, argv);
    io.out(`AI Grader is running at ${String(hello.origin)}`);
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function openReview(paths: AigraderPaths, argv: string[], path: string, io: CliIo): Promise<number> {
  try {
    await ensureServer(paths, argv);
    const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
    const res = await client.request('open', { path });
    client.close();
    if (!res.ok) {
      io.err(`Could not open the review page (${res.error ?? 'unknown error'}).`);
      return 1;
    }
    io.out(String(res.message ?? 'Opened the review page in your browser.'));
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function status(paths: AigraderPaths, io: CliIo): Promise<number> {
  let client;
  try {
    client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
  } catch {
    io.out('AI Grader is not running.');
    return 1;
  }
  const res = await client.request('status');
  client.close();
  if (!res.ok) {
    io.out('AI Grader is starting…');
    return 0;
  }
  const activity = res.activity as { busy: boolean; waiting: boolean; liveRuns: number };
  const config = res.config as {
    file: string;
    instances: Array<{ baseUrl: string; tokenHint: string | null }>;
    problems: string[];
  };
  io.out(`AI Grader ${String(res.version)} is running at ${String(res.origin)}`);
  io.out(`  Open runs: ${activity.liveRuns}${activity.busy ? ' (grading now)' : ''}`);
  const codex = res.codex as {
    state: string;
    message: string | null;
    version: string | null;
    source: string | null;
    usage: { windows: Array<{ usedPercent: number; windowMinutes: number | null }> } | null;
  } | null;
  if (codex) {
    if (codex.state === 'ready') {
      const usage = (codex.usage?.windows ?? [])
        .map((w) => `${Math.round(w.usedPercent)}% of ${w.windowMinutes && w.windowMinutes >= 8640 ? 'weekly' : `${Math.round((w.windowMinutes ?? 0) / 60)}-hour`}`)
        .join(', ');
      io.out(`  Codex: ${codex.version} (${codex.source}), grading model ${String(res.model ?? 'default')}${usage ? `; usage ${usage}` : ''}`);
    } else if (codex.state === 'starting') {
      io.out('  Codex: checking…');
    } else {
      io.out(`  ! Codex: ${codex.message ?? codex.state}`);
    }
  }
  for (const instance of config.instances) {
    io.out(`  Canvas: ${instance.baseUrl} (token ${instance.tokenHint ?? 'missing'})`);
  }
  for (const problem of config.problems) io.out(`  ! ${problem}`);
  return 0;
}

async function stop(paths: AigraderPaths, io: CliIo): Promise<number> {
  let client;
  try {
    client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
  } catch {
    io.out('AI Grader is not running.');
    return 0;
  }
  await client.request('stop');
  client.close();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const probe = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
      probe.close();
    } catch {
      io.out('AI Grader stopped.');
      return 0;
    }
  }
  io.err('AI Grader is taking a while to stop; it will finish saving and exit on its own.');
  return 1;
}
