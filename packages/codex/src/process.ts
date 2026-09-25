// Child-process plumbing for Codex: spawn with piped stdin/stdout/stderr (no
// shell, hidden window), capped capture, and cancellation that kills the
// WHOLE process tree — `codex exec` may start helpers, and a cancelled or
// timed-out grading call must never leave anything running.

import { spawn, spawnSync } from 'node:child_process';

/** How to start Codex: the binary, plus leading args (tests run a Node fake). */
export interface CodexCommand {
  command: string;
  prefixArgs: readonly string[];
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Why we stopped it, when we did. */
  stoppedBy: 'timeout' | 'abort' | null;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError: NodeJS.ErrnoException | null;
  durationMs: number;
}

export interface RunOptions {
  args: readonly string[];
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Capture caps (bytes of text kept, head-first). */
  maxStdout?: number;
  maxStderr?: number;
}

const DEFAULT_MAX_STDOUT = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 64 * 1024;

export function runCodex(cmd: CodexCommand, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stoppedBy: RunResult['stoppedBy'] = null;
    let settled = false;
    const maxOut = opts.maxStdout ?? DEFAULT_MAX_STDOUT;
    const maxErr = opts.maxStderr ?? DEFAULT_MAX_STDERR;

    const finish = (partial: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        stoppedBy,
        spawnError: null,
        durationMs: Date.now() - started,
        ...partial,
      });
    };

    if (opts.signal?.aborted) {
      stoppedBy = 'abort';
      finish({});
      return;
    }

    const child = spawn(cmd.command, [...cmd.prefixArgs, ...opts.args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: own process group, so the whole tree can be signalled at once.
      detached: process.platform !== 'win32',
    });

    const stop = (why: NonNullable<RunResult['stoppedBy']>) => {
      if (stoppedBy) return;
      stoppedBy = why;
      killTree(child.pid);
    };
    const onAbort = () => stop('abort');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs ?? 300_000);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxOut) stdout += chunk.slice(0, maxOut - stdout.length);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxErr) stderr += chunk.slice(0, maxErr - stderr.length);
    });
    child.on('error', (err: NodeJS.ErrnoException) => finish({ spawnError: err }));
    child.on('close', (code, sig) => finish({ exitCode: code, signal: sig }));

    child.stdin.on('error', () => undefined); // a child that exits early closes stdin
    child.stdin.end(opts.stdin ?? '');
  });
}

/** Kills a process and everything it started. Best-effort, never throws. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
