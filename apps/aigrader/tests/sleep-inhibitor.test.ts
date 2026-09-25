// Sleep inhibitor: which helper runs on each OS, idempotent start/stop, and
// graceful degradation when the helper can't start.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createSleepInhibitor, windowsInhibitScript } from '../src/sleep-inhibitor.js';

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const children: Array<EventEmitter & { exitCode: number | null; killed: boolean; kill(): void }> = [];
  const spawnFn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      kill(this: EventEmitter & { killed: boolean; exitCode: number | null }) {
        this.killed = true;
        this.exitCode = 0;
        this.emit('exit', 0);
      },
    });
    children.push(child);
    return child;
  }) as never;
  return { spawnFn, calls, children };
}

describe('sleep inhibitor', () => {
  it('macOS: caffeinate -i -w <pid>, started once, stopped on demand', () => {
    const { spawnFn, calls, children } = fakeSpawn();
    const inhibitor = createSleepInhibitor({ platform: 'darwin', spawnFn, pid: 321 });
    inhibitor.set(true);
    inhibitor.set(true);
    expect(calls).toEqual([{ command: 'caffeinate', args: ['-i', '-w', '321'] }]);
    expect(inhibitor.active).toBe(true);
    inhibitor.set(false);
    expect(children[0]!.killed).toBe(true);
    expect(inhibitor.active).toBe(false);
  });

  it('Windows: a hidden PowerShell SetThreadExecutionState loop bound to our pid', () => {
    const { spawnFn, calls } = fakeSpawn();
    createSleepInhibitor({ platform: 'win32', spawnFn, pid: 999 }).set(true);
    expect(calls[0]!.command).toBe('powershell.exe');
    const encoded = calls[0]!.args[calls[0]!.args.indexOf('-EncodedCommand') + 1]!;
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toBe(windowsInhibitScript(999));
    expect(script).toContain('SetThreadExecutionState');
    expect(script).toContain('Get-Process -Id 999');
  });

  it('Linux: does nothing', () => {
    const { spawnFn, calls } = fakeSpawn();
    const inhibitor = createSleepInhibitor({ platform: 'linux', spawnFn });
    inhibitor.set(true);
    expect(calls).toEqual([]);
    expect(inhibitor.active).toBe(false);
  });

  it('a helper that fails to start disables itself with one warning', () => {
    const { spawnFn, children, calls } = fakeSpawn();
    const warnings: string[] = [];
    const inhibitor = createSleepInhibitor({ platform: 'darwin', spawnFn, warn: (m) => warnings.push(m) });
    inhibitor.set(true);
    children[0]!.emit('error', new Error('spawn caffeinate ENOENT'));
    inhibitor.set(false);
    inhibitor.set(true);
    expect(calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
});
