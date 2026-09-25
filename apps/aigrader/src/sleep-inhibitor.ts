// Best-effort "don't sleep while grading": while a run is drafting or
// posting, the laptop should not doze off mid-run. No OS registration, no
// admin rights — just a helper child process that exits with us:
//   macOS   — `caffeinate -i -w <pid>` (prevents idle sleep until we exit)
//   Windows — a hidden PowerShell loop calling SetThreadExecutionState
//             (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) that ends when we do
//   others  — nothing (not a supported faculty platform)
// If the helper can't start, grading still works; a run interrupted by
// sleep resumes through the normal reconcile path.

import { spawn, type ChildProcess } from 'node:child_process';

export interface SleepInhibitor {
  /** Idempotent: true starts the helper, false stops it. */
  set(active: boolean): void;
  stop(): void;
  readonly active: boolean;
}

type SpawnFn = typeof spawn;

export function windowsInhibitScript(parentPid: number): string {
  return [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
    '$k = Add-Type -MemberDefinition $sig -Name Power -Namespace AIGrader -PassThru',
    'while ($true) {',
    '  [void]$k::SetThreadExecutionState([uint32]"0x80000001")',
    `  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { break }`,
    '  Start-Sleep -Seconds 20',
    '}',
    '[void]$k::SetThreadExecutionState([uint32]"0x80000000")',
  ].join('\n');
}

export function createSleepInhibitor(
  opts: {
    platform?: NodeJS.Platform;
    spawnFn?: SpawnFn;
    pid?: number;
    warn?: (message: string) => void;
  } = {},
): SleepInhibitor {
  const platform = opts.platform ?? process.platform;
  const spawnFn = opts.spawnFn ?? spawn;
  const pid = opts.pid ?? process.pid;
  const warn = opts.warn ?? (() => {});
  let child: ChildProcess | null = null;
  let disabled = platform !== 'darwin' && platform !== 'win32';

  const start = () => {
    if (child || disabled) return;
    try {
      child =
        platform === 'darwin'
          ? spawnFn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' })
          : spawnFn(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-WindowStyle',
                'Hidden',
                '-EncodedCommand',
                Buffer.from(windowsInhibitScript(pid), 'utf16le').toString('base64'),
              ],
              { stdio: 'ignore', windowsHide: true },
            );
      const mine = child;
      mine.once('error', (err) => {
        warn(`[sleep] Could not keep the computer awake while grading: ${err.message}`);
        disabled = true;
        if (child === mine) child = null;
      });
      mine.once('exit', () => {
        if (child === mine) child = null;
      });
    } catch (err) {
      warn(`[sleep] Could not keep the computer awake while grading: ${err instanceof Error ? err.message : String(err)}`);
      disabled = true;
      child = null;
    }
  };

  const stopChild = () => {
    const c = child;
    child = null;
    if (c && c.exitCode === null) c.kill();
  };

  return {
    set(active) {
      if (active) start();
      else stopChild();
    },
    stop: stopChild,
    get active() {
      return child !== null;
    },
  };
}
