// End to end through the REAL Next.js build (skipped until `pnpm build` has
// produced apps/web/.next): the one-time login link becomes a browser
// session; with it — and only with it — a same-origin approve (or Grader
// Settings) request gets past the guard. Curl-style requests never do.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unavailableLlm } from '../src/llm.js';
import { resolvePaths } from '../src/paths.js';
import { startServer, type RunningServer } from '../src/server.js';
import { resolveWebDir } from '../src/web.js';

const built = existsSync(join(resolveWebDir(), '.next', 'BUILD_ID'));

describe.skipIf(!built)('review UI through the real Next build', () => {
  let home: string;
  let server: RunningServer;
  const opened: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'aigrader-e2e-'));
    const paths = resolvePaths({ env: { AIGRADER_HOME: home } });
    writeFileSync(paths.envFile, 'CANVAS_BASE_URL=https://byui.instructure.com\nCANVAS_API_TOKEN=\n');
    server = await startServer({
      paths,
      version: 'e2e',
      port: 0,
      openBrowser: (url) => opened.push(url),
      llm: unavailableLlm(),
      sleepInhibitor: { set: () => {}, stop: () => {}, active: false },
      log: () => {},
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop('test');
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('login link → session; approve passes the guard only with the browser session', async () => {
    const approveUrl = `${server.origin}/api/runs/r1/approve?courseKey=${encodeURIComponent('byui.instructure.com#4242')}`;

    // An agent with curl: refused.
    const bare = await fetch(approveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    expect(bare.status).toBe(403);

    // The server opens the login link in "the browser".
    server.openReview('/connect');
    const login = await fetch(opened[0]!, { redirect: 'manual' });
    expect(login.status).toBe(307);
    expect(login.headers.get('location')).toBe(`${server.origin}/connect`);
    const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]!);
    const csrf = cookies.find((c) => c.startsWith('aigrader_csrf='))!.split('=')[1]!;
    const cookie = cookies.join('; ');

    // The same link is dead now.
    expect((await fetch(opened[0]!, { redirect: 'manual' })).status).toBe(403);

    // The review page's request: past the guard, into the engine (which
    // then can't verify course staff — no Canvas token configured here).
    const fromPage = await fetch(approveUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.origin,
        'sec-fetch-site': 'same-origin',
        'x-aigrader-csrf': decodeURIComponent(csrf),
        cookie,
      },
      body: JSON.stringify({ all: true }),
    });
    expect(fromPage.status).not.toBe(403);
    const body = (await fromPage.json()) as { error?: string };
    expect(body.error).not.toBe('forbidden');

    // Same session, wrong CSRF: refused.
    const noCsrf = await fetch(approveUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.origin,
        'sec-fetch-site': 'same-origin',
        'x-aigrader-csrf': 'guess',
        cookie,
      },
      body: JSON.stringify({ all: true }),
    });
    expect(noCsrf.status).toBe(403);
  }, 60_000);

  it('Grader Settings: read with the browser session, saved only by the review page', async () => {
    const url = `${server.origin}/api/settings`;
    expect((await fetch(url)).status).toBe(401);

    server.openReview('/connect');
    const login = await fetch(opened[opened.length - 1]!, { redirect: 'manual' });
    const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]!);
    const csrf = decodeURIComponent(cookies.find((c) => c.startsWith('aigrader_csrf='))!.split('=')[1]!);
    const cookie = cookies.join('; ');

    const read = await fetch(url, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ settings: { model: '', reasoningEffort: 'medium', maxWorkers: 2 } });

    const put = (headers: Record<string, string>, body: unknown) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: server.origin, 'sec-fetch-site': 'same-origin', cookie, ...headers },
        body: JSON.stringify(body),
      });
    expect((await put({}, { maxWorkers: 3 })).status).toBe(403); // no CSRF echo
    const bad = await put({ 'x-aigrader-csrf': csrf }, { maxWorkers: 12 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_settings' });

    const saved = await put({ 'x-aigrader-csrf': csrf }, { maxWorkers: 3, reasoningEffort: 'low' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ settings: { reasoningEffort: 'low', maxWorkers: 3 } });
    expect(server.runtime.engine.gradeQueue.concurrency).toBe(3);
  }, 60_000);
});
