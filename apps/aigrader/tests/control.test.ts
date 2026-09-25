// The control channel: single-instance lock, the per-start key, request/
// response over newline JSON, and (macOS/Linux) stale-socket recovery.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AlreadyRunningError,
  ControlUnavailableError,
  connectControl,
  listenControl,
  type ControlServer,
} from '../src/control.js';
import { resolvePaths } from '../src/paths.js';

let dir: string;
let endpoint: string;
let keyFile: string;
const servers: ControlServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aigrader-ctl-'));
  const paths = resolvePaths({ env: { AIGRADER_HOME: dir } });
  endpoint = paths.controlEndpoint;
  keyFile = join(dir, 'control.key');
  writeFileSync(keyFile, 'k3y');
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function listen(handler = (r: { op: string }) => ({ ok: true, echo: r.op })) {
  const server = await listenControl({ endpoint, key: () => 'k3y', handler });
  servers.push(server);
  return server;
}

describe('control channel', () => {
  it('answers authenticated requests and counts open connections', async () => {
    const server = await listen();
    const client = await connectControl({ endpoint, keyFile });
    expect(client.hello).toMatchObject({ ok: true, echo: 'hello' });
    expect(server.connections).toBe(1);
    expect(await client.request('status')).toMatchObject({ ok: true, echo: 'status' });
    client.close();
    for (let i = 0; i < 50 && server.connections > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(server.connections).toBe(0);
  });

  it('is a single-instance lock: a second listener finds the first', async () => {
    await listen();
    await expect(listenControl({ endpoint, key: () => 'x', handler: () => ({ ok: true }) })).rejects.toBeInstanceOf(
      AlreadyRunningError,
    );
  });

  it('refuses a connection with the wrong key', async () => {
    await listen();
    writeFileSync(keyFile, 'wrong');
    await expect(connectControl({ endpoint, keyFile })).rejects.toBeInstanceOf(ControlUnavailableError);
  });

  it('reports "not running" when nobody listens or the key file is missing', async () => {
    await expect(connectControl({ endpoint, keyFile })).rejects.toBeInstanceOf(ControlUnavailableError);
    rmSync(keyFile);
    await expect(connectControl({ endpoint, keyFile })).rejects.toBeInstanceOf(ControlUnavailableError);
  });

  it.skipIf(process.platform === 'win32')('recovers a stale socket file left by a crash', async () => {
    // Leave a socket file behind with no listener (simulated crash).
    const ghost = createServer();
    await new Promise<void>((r) => ghost.listen(endpoint, () => r()));
    await new Promise<void>((r) => {
      // close() would unlink the file; keep it by dropping the handle abruptly
      (ghost as unknown as { _handle: { close(): void } })._handle.close();
      r();
    });
    const server = await listen();
    const client = await connectControl({ endpoint, keyFile });
    expect(client.hello.ok).toBe(true);
    client.close();
    expect(server.endpoint).toBe(endpoint);
  });
});
