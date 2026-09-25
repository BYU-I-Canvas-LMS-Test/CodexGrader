// The local server end to end (real loopback HTTP + real control channel;
// the Next app is replaced by a tiny handler, the browser by a recorder):
// loopback + exact-Host serving, port fallback, single instance, the login
// link that never leaves the server, secret-free status/server.json, live
// .env reload, and idle / requested shutdown.

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_GLOBAL } from '@aigrader/shared';
import { createCodexBackend } from '@aigrader/codex';
import { AlreadyRunningError, connectControl } from '../src/control.js';
import { unavailableLlm } from '../src/llm.js';
import { resolvePaths, type AigraderPaths } from '../src/paths.js';
import { startServer, type RunningServer, type StartServerOptions } from '../src/server.js';

const TOKEN = '12345~AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

let home: string;
let paths: AigraderPaths;
let opened: string[];
const running: RunningServer[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aigrader-srv-'));
  paths = resolvePaths({ env: { AIGRADER_HOME: home } });
  writeFileSync(paths.envFile, `CANVAS_BASE_URL=https://byui.instructure.com\nCANVAS_API_TOKEN=${TOKEN}\n`);
  opened = [];
});

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop('test');
  rmSync(home, { recursive: true, force: true });
});

async function start(overrides: Partial<StartServerOptions> = {}): Promise<RunningServer> {
  const server = await startServer({
    paths,
    version: '9.9.9-test',
    port: 0,
    web: async () => ({
      handle: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`web:${req.url}`);
      },
    }),
    openBrowser: (url) => opened.push(url),
    sleepInhibitor: { set: () => {}, stop: () => {}, active: false },
    log: () => {},
    llm: unavailableLlm(), // hermetic: never probe the real Codex here
    ...overrides,
  });
  running.push(server);
  return server;
}

const FAKE_CODEX = fileURLToPath(new URL('../../../packages/codex/tests/fake-codex/fake-codex.mjs', import.meta.url));

function get(port: number, path: string, hostHeader: string): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('local server', () => {
  it('serves its exact 127.0.0.1 origin only, and installs the LocalHost for the web tier', async () => {
    const server = await start();
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);

    expect(await get(server.port, '/courses', `127.0.0.1:${server.port}`)).toMatchObject({
      status: 200,
      body: 'web:/courses',
    });
    // DNS rebinding: a foreign Host is refused.
    expect((await get(server.port, '/', 'evil.example')).status).toBe(421);
    // "localhost" is sent to the canonical origin (the session cookie lives there).
    expect(await get(server.port, '/x?y=1', `localhost:${server.port}`)).toMatchObject({
      status: 302,
      location: `${server.origin}/x?y=1`,
    });

    expect((globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL]).toBe(server.host);
  });

  it('server.json and status carry no secrets', async () => {
    const server = await start();
    const info = readFileSync(paths.serverJsonFile, 'utf8');
    expect(JSON.parse(info)).toMatchObject({ port: server.port, pid: process.pid, version: '9.9.9-test' });

    const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
    const status = await client.request('status');
    client.close();
    expect(status).toMatchObject({ ok: true, origin: server.origin });
    const blob = JSON.stringify(status) + info;
    expect(blob).not.toContain(TOKEN.slice(0, 16));
    expect(blob).toContain('…6789');
  });

  it('is a single instance: a second server on the same profile finds the first', async () => {
    await start();
    await expect(start()).rejects.toBeInstanceOf(AlreadyRunningError);
  });

  it('falls back to the next port when the preferred one is taken', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const server = await start({ port: taken });
      expect(server.port).not.toBe(taken);
    } finally {
      blocker.close();
    }
  });

  it('"open" launches the browser with a single-use login link that never reaches the caller', async () => {
    const server = await start();
    const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
    const res = await client.request('open', { path: '/courses/abc/runs/r1' });
    const unsafe = await client.request('open', { path: '//evil.example/x' });
    client.close();

    expect(res.ok).toBe(true);
    expect(unsafe.ok).toBe(true);
    expect(opened).toHaveLength(2);
    const url = new URL(opened[0]!);
    expect(url.origin).toBe(server.origin);
    expect(url.pathname).toBe('/session/start');
    expect(url.searchParams.get('next')).toBe('/courses/abc/runs/r1');
    expect(new URL(opened[1]!).searchParams.get('next')).toBe('/');

    const token = url.searchParams.get('token')!;
    expect(JSON.stringify(res)).not.toContain(token);
    expect(server.host.redeemLoginToken(token)).toBeTruthy();
    expect(server.host.redeemLoginToken(token)).toBeNull();
  });

  it('picks up an edited .env without a restart', async () => {
    const server = await start({ envPollMs: 20 });
    const instances = async () => {
      const res = await server.host.engine({ method: 'GET', url: '/canvas/instances' });
      return JSON.stringify(JSON.parse(new TextDecoder().decode(res.body)));
    };
    expect(await instances()).toContain('byui.instructure.com');
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(
      paths.envFile,
      `CANVAS_BASE_URL=https://byui.instructure.com\nCANVAS_API_TOKEN=${TOKEN}\n` +
        `CANVAS_BASE_URL_2=https://canvas.other.edu\nCANVAS_API_TOKEN_2=${TOKEN}zz\n`,
    );
    let seen = '';
    for (let i = 0; i < 100 && !seen.includes('canvas.other.edu'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      seen = await instances();
    }
    expect(seen).toContain('canvas.other.edu');
    expect(seen).not.toContain(TOKEN.slice(0, 16));
  });

  it('shuts itself down when idle, cleaning up server.json and the lock', async () => {
    const server = await start({ idleShutdownMs: 60, idleCheckMs: 20 });
    expect(await server.stopped).toBe('idle');
    expect(existsSync(paths.serverJsonFile)).toBe(false);
    expect(existsSync(paths.controlKeyFile)).toBe(false);
    expect((globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL]).toBeUndefined();
    // The lock is free again.
    const again = await start();
    expect(again.port).toBeGreaterThan(0);
  });

  it('an open control connection (a Codex session) keeps it from idling out', async () => {
    const server = await start({ idleShutdownMs: 60, idleCheckMs: 20 });
    const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(paths.serverJsonFile)).toBe(true);
    client.close();
    expect(await server.stopped).toBe('idle');
  });

  it('"stop" over the control channel stops it', async () => {
    const server = await start();
    const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
    expect(await client.request('stop')).toMatchObject({ ok: true });
    client.close();
    expect(await server.stopped).toBe('requested');
  });
});

describe('with the Codex backend (FakeCodex)', () => {
  it('resolves the grading model from the account catalog and reports Codex + usage in status', async () => {
    process.env.FAKE_CODEX_DIR = join(home, 'fake');
    process.env.FAKE_CODEX_USAGE = JSON.stringify({ primary: 5, secondary: 66 });
    writeFileSync(
      paths.envFile,
      `CANVAS_BASE_URL=https://byui.instructure.com
CANVAS_API_TOKEN=${TOKEN}
AIGRADER_MODEL=gpt-6-astra
`,
    );
    const logs: string[] = [];
    const codex = createCodexBackend({
      command: { command: process.execPath, prefixArgs: [FAKE_CODEX] },
      stateDir: join(home, 'state', 'codex'),
    });
    const server = await start({ llm: undefined, codex, log: (m) => logs.push(m) });
    await codex.ready;
    for (let i = 0; i < 50 && server.runtime.config.model !== 'gpt-fake-sol'; i++) await new Promise((r) => setTimeout(r, 10));
    // gpt-6-astra isn't on this account → the account default, with a note.
    expect(server.runtime.config.model).toBe('gpt-fake-sol');
    expect(logs.some((l) => l.includes('AIGRADER_MODEL=gpt-6-astra is not available'))).toBe(true);

    const client = await connectControl({ endpoint: paths.controlEndpoint, keyFile: paths.controlKeyFile });
    const status = await client.request('status');
    client.close();
    expect(status).toMatchObject({
      model: 'gpt-fake-sol',
      codex: { state: 'ready', version: '0.155.0-fake', usage: { windows: [{ usedPercent: 5 }, { usedPercent: 66 }] } },
    });
    delete process.env.FAKE_CODEX_DIR;
    delete process.env.FAKE_CODEX_USAGE;
  }, 30_000);
});
