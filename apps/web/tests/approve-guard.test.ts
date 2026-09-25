// The human-in-the-loop fence on the web side:
//   - browserMutationGuard: session cookie + CSRF header + exact Origin +
//     Sec-Fetch-Site + JSON must ALL be present — a curl-style request that
//     never held the browser session is refused, and so is a request from
//     another web page.
//   - /session/start: a single-use login token becomes the session + CSRF
//     cookies (HttpOnly/SameSite=Strict); unknown tokens are refused; `next`
//     only redirects same-origin.
//   - /api/runs/[runId]/approve: guard first, then the capability path
//     (LocalHost.approve) — never the capability-less engine() dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LOCAL_HOST_GLOBAL, type LocalHost } from '@aigrader/shared';
import { CSRF_COOKIE, CSRF_HEADER, browserMutationGuard } from '../lib/auth/local-session';

vi.mock('../lib/auth/resolve-context', () => ({
  requireCourseStaff: vi.fn(async (courseKey: string) => ({
    authSource: 'local',
    user: { displayName: 'Prof. Ada', canvasUserId: '553' },
    canvasBaseUrl: 'https://byui.instructure.com',
    courseId: '4242',
    courseKey,
    courseName: 'Biology 101',
    roles: ['teacher'],
    isCourseStaff: true,
  })),
  requireGradingContext: vi.fn(),
}));

const ORIGIN = 'http://127.0.0.1:47821';
const COURSE_KEY = 'byui.instructure.com#4242';
const SESSION = 'session-value-abc';
const CSRF = 'csrf-for-session-abc';

function json(body: unknown, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function fakeHost(): LocalHost & { engineCalls: unknown[]; approveCalls: unknown[] } {
  const engineCalls: unknown[] = [];
  const approveCalls: unknown[] = [];
  const tokens = new Set(['one-time-token']);
  return {
    version: 'test',
    origin: ORIGIN,
    sessionCookieName: 'aigrader_session',
    engineCalls,
    approveCalls,
    async engine(request) {
      engineCalls.push(request);
      if (request.url.includes('/progress')) {
        return json({ progress: { runId: 'run1', courseKey: COURSE_KEY } });
      }
      return json({ approved: 999 }); // must never be used for approve
    },
    async approve(runId, body) {
      approveCalls.push({ runId, body });
      return json({ approved: 2 });
    },
    verifySession: (value) => value === SESSION,
    redeemLoginToken: (token) => (tokens.delete(token) ? SESSION : null),
    csrfTokenFor: (session) => (session === SESSION ? CSRF : 'nope'),
    noteActivity: () => {},
  };
}

let host: ReturnType<typeof fakeHost>;

beforeEach(() => {
  host = fakeHost();
  (globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL] = host;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL];
});

function browserRequest(
  overrides: {
    headers?: Record<string, string | null>;
    cookie?: string | null;
    body?: unknown;
    path?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    [CSRF_HEADER]: CSRF,
  };
  for (const [k, v] of Object.entries(overrides.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  const cookie = overrides.cookie === undefined ? `aigrader_session=${SESSION}` : overrides.cookie;
  if (cookie) headers.cookie = cookie;
  const path = overrides.path ?? '/api/runs/run1/approve';
  return new NextRequest(`${ORIGIN}${path}?courseKey=${encodeURIComponent(COURSE_KEY)}`, {
    method: 'POST',
    headers,
    body: overrides.body === null ? undefined : JSON.stringify(overrides.body ?? { all: true }),
  });
}

describe('browserMutationGuard', () => {
  it('lets the review page through when every check passes', () => {
    expect(browserMutationGuard(browserRequest())).toBeNull();
  });

  it.each([
    ['no session cookie (curl / an agent)', { cookie: null }],
    ['a forged session cookie', { cookie: 'aigrader_session=guess' }],
    ['no CSRF header', { headers: { [CSRF_HEADER]: null } }],
    ['a wrong CSRF header', { headers: { [CSRF_HEADER]: 'guess' } }],
    ['another origin', { headers: { origin: 'http://127.0.0.1:9999' } }],
    ['no Origin header', { headers: { origin: null } }],
    ['a cross-site fetch', { headers: { 'sec-fetch-site': 'cross-site' } }],
    ['no Sec-Fetch-Site (non-browser client)', { headers: { 'sec-fetch-site': null } }],
    ['a text/plain simple request', { headers: { 'content-type': 'text/plain' } }],
  ])('refuses %s', (_label, overrides) => {
    const res = browserMutationGuard(browserRequest(overrides as never));
    expect(res?.status).toBe(403);
  });
});

describe('/session/start', () => {
  it('redeems a single-use token into HttpOnly session + readable CSRF cookies', async () => {
    const { GET } = await import('../app/session/start/route');
    const res = await GET(
      new NextRequest(`${ORIGIN}/session/start?token=one-time-token&next=/courses/x`),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/courses/x`);
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/aigrader_session=session-value-abc;[^\n]*HttpOnly/i);
    expect(setCookie).toMatch(/aigrader_session=[^\n]*SameSite=strict/i);
    expect(setCookie).toContain(`${CSRF_COOKIE}=${CSRF}`);

    // Single use: the same token is refused the second time.
    const again = await GET(new NextRequest(`${ORIGIN}/session/start?token=one-time-token`));
    expect(again.status).toBe(403);
  });

  it('never redirects off-origin', async () => {
    const { GET } = await import('../app/session/start/route');
    host = fakeHost();
    (globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL] = host;
    const res = await GET(
      new NextRequest(`${ORIGIN}/session/start?token=one-time-token&next=//evil.example/x`),
    );
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });
});

describe('POST /api/runs/[runId]/approve', () => {
  it('approves through the capability path once the guard passes', async () => {
    const { POST } = await import('../app/api/runs/[runId]/approve/route');
    const res = await POST(browserRequest(), { params: Promise.resolve({ runId: 'run1' }) });
    expect(res.status).toBe(200);
    // The approver is the resolved Canvas user — never taken from the body.
    expect(host.approveCalls).toEqual([
      { runId: 'run1', body: { all: true, approver: { canvasUserId: 553, name: 'Prof. Ada' } } },
    ]);
    // The capability-less engine() was used only for the run lookup.
    expect(
      host.engineCalls.every((c) => !(c as { url: string }).url.endsWith('/approve')),
    ).toBe(true);
  });

  it('ignores an approver in the request body (the prefix name cannot be spoofed)', async () => {
    const { POST } = await import('../app/api/runs/[runId]/approve/route');
    const res = await POST(
      browserRequest({ body: { userIds: [1], approver: { canvasUserId: 1, name: 'Someone Else' } } }),
      { params: Promise.resolve({ runId: 'run1' }) },
    );
    expect(res.status).toBe(200);
    expect(host.approveCalls).toEqual([
      { runId: 'run1', body: { userIds: [1], approver: { canvasUserId: 553, name: 'Prof. Ada' } } },
    ]);
  });

  it('refuses a request without the browser session and never calls approve', async () => {
    const { POST } = await import('../app/api/runs/[runId]/approve/route');
    const res = await POST(browserRequest({ cookie: null }), {
      params: Promise.resolve({ runId: 'run1' }),
    });
    expect(res.status).toBe(403);
    expect(host.approveCalls).toHaveLength(0);
  });
});

describe('guarded run mutations (rerun / revert / cancel / resume / edit)', () => {
  const routes = {
    rerun: () => import('../app/api/runs/[runId]/rerun/route'),
    revert: () => import('../app/api/runs/[runId]/revert/route'),
    cancel: () => import('../app/api/runs/[runId]/cancel/route'),
    resume: () => import('../app/api/runs/[runId]/resume/route'),
    edit: () => import('../app/api/runs/[runId]/edit/route'),
  };

  it.each(Object.keys(routes))('%s refuses a request without the browser session', async (name) => {
    const { POST } = await routes[name as keyof typeof routes]();
    const res = await POST(browserRequest({ cookie: null, path: `/api/runs/run1/${name}` }), {
      params: Promise.resolve({ runId: 'run1' }),
    });
    expect(res.status).toBe(403);
    expect(host.engineCalls).toHaveLength(0);
  });

  it('rerun relays the targets to the engine', async () => {
    const { POST } = await routes.rerun();
    const res = await POST(browserRequest({ path: '/api/runs/run1/rerun', body: { userIds: [3] } }), {
      params: Promise.resolve({ runId: 'run1' }),
    });
    expect(res.status).toBe(200);
    const call = host.engineCalls.find((c) => (c as { url: string }).url.endsWith('/rerun')) as {
      body: unknown;
    };
    expect(call).toBeDefined();
  });

  it('cancel and resume accept an empty body (no content-type)', async () => {
    for (const name of ['cancel', 'resume'] as const) {
      const { POST } = await routes[name]();
      const res = await POST(
        browserRequest({ path: `/api/runs/run1/${name}`, body: null, headers: { 'content-type': null } }),
        { params: Promise.resolve({ runId: 'run1' }) },
      );
      expect(res.status).toBe(200);
    }
  });
});
