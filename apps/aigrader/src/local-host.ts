// The LocalHost the Next.js web tier reaches the engine through (contract:
// @aigrader/shared local-host.ts). Installed on globalThis before Next starts.
//
//   engine()  → in-memory dispatch (light-my-request) into the engine app
//               built WITHOUT the approval capability — it cannot approve.
//   approve() → the same dispatch into the engine app that holds the random,
//               in-memory approval capability. Only the browser-guarded web
//               approve route calls it.
//
// Browser sessions: the server opens a one-time login URL in the system
// browser (`aigrader open`, MCP `request_posting`). The URL's token is
// random, single-use, and expires in 30 seconds; redeeming it mints an
// HMAC-signed session cookie value (12 h). The CSRF token is an HMAC of the
// session value — nothing to store, nothing to leak. The signing key exists
// only in this process's memory, so every restart invalidates old sessions.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { inject, type DispatchFunc } from 'light-my-request';
import type { EngineDispatchRequest, EngineDispatchResponse, LocalHost } from '@aigrader/shared';
import { APPROVAL_CAPABILITY_HEADER } from '@aigrader/engine';

export const SESSION_COOKIE_NAME = 'aigrader_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_TOKEN_TTL_MS = 30 * 1000;

export interface LocalHostOptions {
  version: string;
  origin: string;
  /** Engine app WITHOUT the approval capability (everything but approve). */
  engineApp: DispatchFunc;
  /** Engine app WITH the approval capability (approve only). */
  approveApp: DispatchFunc;
  approvalCapability: string;
  onActivity?: () => void;
  now?: () => number;
}

/** The server-side extras beyond the web-facing contract. */
export interface LocalHostImpl extends LocalHost {
  /** A fresh single-use login token for a URL the SERVER opens in the
   * system browser. Never print it, never return it from a tool. */
  issueLoginToken(): string;
}

export function createLocalHost(options: LocalHostOptions): LocalHostImpl {
  const now = options.now ?? Date.now;
  const key = randomBytes(32);
  const loginTokens = new Map<string, number>(); // token → expiresAt

  const mac = (purpose: string, value: string) =>
    createHmac('sha256', key).update(`${purpose}\0${value}`).digest('base64url');

  const sameText = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  const newSession = (): string => {
    const id = randomBytes(18).toString('base64url');
    const expires = String(now() + SESSION_TTL_MS);
    return `${id}.${expires}.${mac('session', `${id}.${expires}`)}`;
  };

  const verifySession = (value: string | undefined): boolean => {
    if (!value) return false;
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const [id, expires, signature] = parts as [string, string, string];
    if (!sameText(signature, mac('session', `${id}.${expires}`))) return false;
    const expiresAt = Number(expires);
    return Number.isFinite(expiresAt) && expiresAt > now();
  };

  const dispatch = async (
    app: DispatchFunc,
    request: EngineDispatchRequest,
    extraHeaders: Record<string, string> = {},
  ): Promise<EngineDispatchResponse> => {
    const hasBody = request.method !== 'GET' && request.body !== undefined;
    const res = await inject(app, {
      method: request.method,
      url: request.url,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...request.headers,
        ...extraHeaders,
      },
      ...(hasBody ? { payload: JSON.stringify(request.body) } : {}),
    });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return { status: res.statusCode, headers, body: new Uint8Array(res.rawPayload) };
  };

  return {
    version: options.version,
    origin: options.origin,
    sessionCookieName: SESSION_COOKIE_NAME,

    async engine(request) {
      // Never forward a caller-supplied capability header into either app.
      const headers = { ...request.headers };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === APPROVAL_CAPABILITY_HEADER) delete headers[name];
      }
      return dispatch(options.engineApp, { ...request, headers });
    },

    async approve(runId, body) {
      return dispatch(
        options.approveApp,
        { method: 'POST', url: `/runs/${encodeURIComponent(runId)}/approve`, body },
        { [APPROVAL_CAPABILITY_HEADER]: options.approvalCapability },
      );
    },

    verifySession,

    redeemLoginToken(token) {
      const expiresAt = loginTokens.get(token);
      if (expiresAt === undefined) return null;
      loginTokens.delete(token); // single use, even when expired
      if (expiresAt <= now()) return null;
      return newSession();
    },

    csrfTokenFor(sessionValue) {
      return mac('csrf', sessionValue);
    },

    noteActivity() {
      options.onActivity?.();
    },

    issueLoginToken() {
      const t = now();
      for (const [token, expiresAt] of loginTokens) {
        if (expiresAt <= t) loginTokens.delete(token);
      }
      const token = randomBytes(32).toString('base64url');
      loginTokens.set(token, t + LOGIN_TOKEN_TTL_MS);
      return token;
    },
  };
}
