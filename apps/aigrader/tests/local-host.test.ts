// LocalHost: the approval boundary between the web tier and the in-process
// engine (real engine apps, no network), plus the browser session: single-
// use 30-second login tokens, HMAC session values, CSRF derivation.

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CAPABILITY_HEADER,
  LocalProgressStore,
  StaticCredentialProvider,
  createEngine,
  createEngineApp,
  engineConfigFromEnv,
} from '@aigrader/engine';
import { unavailableLlm } from '../src/llm.js';
import { LOGIN_TOKEN_TTL_MS, SESSION_TTL_MS, createLocalHost } from '../src/local-host.js';

function buildHost(now: () => number = Date.now) {
  const credentials = new StaticCredentialProvider([]);
  const llm = unavailableLlm();
  const runtime = createEngine({
    credentials,
    llm,
    progressStore: new LocalProgressStore(),
    config: engineConfigFromEnv({}),
  });
  const capability = 'the-real-capability-0123456789abcdef';
  const host = createLocalHost({
    version: 'test',
    origin: 'http://127.0.0.1:47821',
    engineApp: createEngineApp({ runtime, credentials, llm }),
    approveApp: createEngineApp({ runtime, credentials, llm, approvalCapability: capability }),
    approvalCapability: capability,
    now,
  });
  return { host, capability };
}

const text = (body: Uint8Array) => new TextDecoder().decode(body);
const APPROVE_BODY = { all: true, approver: { canvasUserId: 5, name: 'Prof' } };

describe('the approval boundary', () => {
  it('engine() can NEVER approve — not even when handed the real capability header', async () => {
    const { host, capability } = buildHost();
    const res = await host.engine({
      method: 'POST',
      url: '/runs/run1/approve',
      headers: { [APPROVAL_CAPABILITY_HEADER]: capability, 'X-AIGRADER-APPROVAL': capability },
      body: APPROVE_BODY,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(text(res.body))).toMatchObject({ error: 'approval_requires_browser' });
  });

  it('approve() passes the capability gate (the unknown run then 404s in the engine)', async () => {
    const { host } = buildHost();
    const res = await host.approve('run1', APPROVE_BODY);
    expect(res.status).toBe(404);
    expect(JSON.parse(text(res.body))).toMatchObject({ error: 'unknown_run' });
  });

  it('engine() dispatches ordinary requests in memory', async () => {
    const { host } = buildHost();
    const res = await host.engine({ method: 'GET', url: '/canvas/instances' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('browser sessions', () => {
  it('a login token is single-use and becomes a verifiable session', () => {
    const { host } = buildHost();
    const token = host.issueLoginToken();
    const session = host.redeemLoginToken(token);
    expect(session).toBeTruthy();
    expect(host.verifySession(session!)).toBe(true);
    expect(host.redeemLoginToken(token)).toBeNull(); // used
    expect(host.redeemLoginToken('guessed-token')).toBeNull();
  });

  it('a login token expires after 30 seconds', () => {
    let t = 1_000_000;
    const { host } = buildHost(() => t);
    const token = host.issueLoginToken();
    t += LOGIN_TOKEN_TTL_MS + 1;
    expect(host.redeemLoginToken(token)).toBeNull();
  });

  it('sessions expire, and tampered or foreign session values are refused', () => {
    let t = 1_000_000;
    const { host } = buildHost(() => t);
    const session = host.redeemLoginToken(host.issueLoginToken())!;
    const [id, expires, sig] = session.split('.') as [string, string, string];
    expect(host.verifySession(`${id}.${Number(expires) + 999999}.${sig}`)).toBe(false);
    expect(host.verifySession(`${id}x.${expires}.${sig}`)).toBe(false);
    expect(host.verifySession(undefined)).toBe(false);
    expect(host.verifySession('a.b')).toBe(false);

    // Another server process (different key) never accepts this session.
    const { host: other } = buildHost(() => t);
    expect(other.verifySession(session)).toBe(false);

    t += SESSION_TTL_MS + 1;
    expect(host.verifySession(session)).toBe(false);
  });

  it('CSRF tokens are stable per session and differ between sessions', () => {
    const { host } = buildHost();
    const a = host.redeemLoginToken(host.issueLoginToken())!;
    const b = host.redeemLoginToken(host.issueLoginToken())!;
    expect(host.csrfTokenFor(a)).toBe(host.csrfTokenFor(a));
    expect(host.csrfTokenFor(a)).not.toBe(host.csrfTokenFor(b));
    expect(host.csrfTokenFor(a)).not.toContain(a);
  });
});
