// Shared HTTP plumbing for the Canvas API + Files clients: gate-wrapped fetch,
// transient-error retry, rate-limit awareness, HTML-login-page detection, and
// Link-header pagination. Every Canvas request in this package funnels
// through CanvasHttp.send().
//
// Ported from: C:\Devs\AIgrader\lib\canvas\client.ts (request/getPaginated/
// parseJsonResponse/buildUrl/encodeForm internals — bearer auth, 429/5xx retry
// with exponential backoff + jitter, retry-after, X-Rate-Limit-Remaining
// pause, 200-with-HTML detection) and
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasApiClient.cs
// (SendAsync — per-request gate slot, 403-with-"Rate Limit Exceeded" body
// treated as transient, bearer attached only to Canvas-host targets).

import { z } from 'zod';
import { CanvasError } from './errors.js';
import { CanvasGate } from './gate.js';
import { parseNextLink } from './pagination.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | string[] | number[] | undefined;

export type CanvasClientOptions = {
  /** Canvas instance base URL, e.g. "https://school.instructure.com". */
  baseUrl: string;
  /** Bearer token. Resolved by the caller (the engine's credential provider) — never read from env here. */
  token: string;
  /** Per-token concurrency gate; a private gate is created when omitted. */
  gate?: CanvasGate;
  /** Suffix allowlist for forDomain routing (default ['.instructure.com']). */
  trustedSuffixes?: readonly string[];
  /** Retries after the first attempt for 429/5xx/network errors (default 5). */
  maxRetries?: number;
  /** Per-attempt timeout (default 120s). A hung Canvas connection counts as a
   * transient network failure and is retried. */
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable fetch for tests; defaults to global fetch (Node 18+/24). */
  fetch?: FetchLike;
};

export type SendOptions = {
  body?: RequestInit['body'];
  headers?: Record<string, string>;
  redirect?: RequestInit['redirect'];
  /** Overrides the client's per-attempt timeout for this request. */
  timeoutMs?: number;
  /**
   * Whether the bearer may be attached at all. Even when true, the bearer is
   * only sent to the Canvas host this client is bound to (exfiltration guard).
   */
  withAuth?: boolean;
};

/** Best-effort body drain so undici can release the connection. */
export async function drainResponse(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // already consumed or aborted — nothing to release
  }
}

/** Validates a parsed JSON body against a schema, shaping failures as CanvasError. */
export function parsed<S extends z.ZodTypeAny>(schema: S, value: unknown, url: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new CanvasError(200, url, `Canvas response failed validation: ${issues}`);
  }
  return result.data as z.infer<S>;
}

export function encodeForm(
  params:
    | Record<string, string | number | boolean | undefined>
    | ReadonlyArray<readonly [string, string]>,
): string {
  const out = new URLSearchParams();
  if (Array.isArray(params)) {
    for (const [k, v] of params as ReadonlyArray<readonly [string, string]>) out.append(k, v);
  } else {
    for (const [k, v] of Object.entries(params as Record<string, string | number | boolean | undefined>)) {
      if (v === undefined) continue;
      out.append(k, String(v));
    }
  }
  return out.toString();
}

/** Per-attempt Canvas request timeout. */
export const DEFAULT_TIMEOUT_MS = 120_000;

export class CanvasHttp {
  readonly baseUrl: string;
  readonly gate: CanvasGate;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: CanvasClientOptions) {
    if (!options.baseUrl) throw new Error('CanvasClient: baseUrl is required.');
    if (!options.token) throw new Error('CanvasClient: token is required.');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.gate = options.gate ?? new CanvasGate();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 5;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? 'byui-ai-grader/0.1';
  }

  /**
   * True when `url` points at the Canvas host this client is bound to — the
   * precondition for attaching the bearer token to any request.
   */
  isCanvasHost(url: string): boolean {
    try {
      return new URL(url).host === new URL(this.baseUrl).host;
    } catch {
      return false;
    }
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const base = path.startsWith('http')
      ? path
      : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (!query) return base;
    const url = new URL(base);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.append(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * Sends one request through the gate with transient-error retry. Does NOT
   * throw on non-2xx statuses (callers decide); throws only when the network
   * itself fails past the retry budget. Transient = 429, 5xx, or Canvas's
   * alternate throttle signal: 403 with a "Rate Limit Exceeded" body.
   */
  async send(method: string, url: string, opts: SendOptions = {}): Promise<Response> {
    const withAuth = opts.withAuth ?? true;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        // The gate slot covers the request AND the proactive low-budget pause
        // (mirrors the C# SendAsync, which held its slot through the pause).
        res = await this.gate.run(async () => {
          const r = await this.fetchImpl(url, {
            method,
            body: opts.body,
            redirect: opts.redirect,
            // Covers connect + headers + body read; created per attempt.
            signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
            headers: {
              ...(withAuth && this.isCanvasHost(url)
                ? { Authorization: `Bearer ${this.token}` }
                : {}),
              Accept: 'application/json',
              'User-Agent': this.userAgent,
              ...opts.headers,
            },
          });
          // Honor Canvas's soft rate-limit signal: when X-Rate-Limit-Remaining
          // dips below 100 the API is about to start rejecting; back off
          // proactively rather than wait for a 403.
          const remaining = r.headers.get('x-rate-limit-remaining');
          if (remaining !== null && Number(remaining) < 100) await sleep(250);
          return r;
        });
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxRetries) throw err;
        await sleep(backoffMs(attempt, null));
        continue;
      }

      let transient = res.status === 429 || res.status >= 500;
      if (!transient && res.status === 403) {
        // Canvas signals throttling as 403 with this body, not only 429.
        const body = await res.clone().text().catch(() => '');
        transient = body.toLowerCase().includes('rate limit exceeded');
      }
      if (!transient || attempt === this.maxRetries) return res;

      const retryAfter = res.headers.get('retry-after');
      await drainResponse(res);
      await sleep(backoffMs(attempt, retryAfter));
    }

    throw lastErr instanceof Error ? lastErr : new Error('Canvas request failed');
  }

  /** send() + throw a CanvasError (with truncated body) on any non-2xx status. */
  async requestOk(method: string, url: string, opts: SendOptions = {}): Promise<Response> {
    const res = await this.send(method, url, opts);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new CanvasError(res.status, url, body);
    }
    return res;
  }

  /**
   * Parses a response body as JSON, failing loudly with a useful CanvasError
   * when the body is actually HTML — Canvas's signature move when a token is
   * invalid or the session bounced to login (status is still 200 in that
   * case) — instead of the cryptic "Unexpected token '<'" SyntaxError.
   */
  async parseJson(res: Response, url: string): Promise<unknown> {
    const text = await res.text();
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<')) {
      const ct = res.headers.get('content-type') ?? 'unknown';
      throw new CanvasError(
        res.status,
        url,
        `Expected JSON but received ${ct}. Canvas likely redirected this request to an HTML page — ` +
          'the API token may be invalid or lack permission for this endpoint.',
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CanvasError(res.status, url, `Invalid JSON from Canvas: ${text.slice(0, 200)}`);
    }
  }

  async getJson(path: string, query?: Record<string, QueryValue>): Promise<unknown> {
    const url = this.buildUrl(path, query);
    const res = await this.requestOk('GET', url);
    return this.parseJson(res, url);
  }

  /** Fetches all pages of a list endpoint by following Link rel="next". */
  async getPaginated(path: string, query?: Record<string, QueryValue>): Promise<unknown[]> {
    const out: unknown[] = [];
    let url: string | null = this.buildUrl(path, query);
    while (url) {
      const res = await this.requestOk('GET', url);
      const page = await this.parseJson(res, url);
      if (Array.isArray(page)) out.push(...page);
      url = parseNextLink(res.headers.get('link'));
    }
    return out;
  }

  /** Pagination for endpoints that wrap each page under a key (e.g. quiz_submissions). */
  async getPaginatedWrapped(
    path: string,
    wrapperKey: string,
    query?: Record<string, QueryValue>,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    let url: string | null = this.buildUrl(path, query);
    while (url) {
      const res = await this.requestOk('GET', url);
      const page = await this.parseJson(res, url);
      const items =
        page !== null && typeof page === 'object'
          ? (page as Record<string, unknown>)[wrapperKey]
          : undefined;
      if (Array.isArray(items)) out.push(...items);
      url = parseNextLink(res.headers.get('link'));
    }
    return out;
  }

  async postForm(
    path: string,
    params:
      | Record<string, string | number | boolean | undefined>
      | ReadonlyArray<readonly [string, string]>,
  ): Promise<unknown> {
    const url = this.buildUrl(path);
    const res = await this.requestOk('POST', url, {
      body: encodeForm(params),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return this.parseJson(res, url);
  }

  async putForm(
    path: string,
    params:
      | Record<string, string | number | boolean | undefined>
      | ReadonlyArray<readonly [string, string]>,
  ): Promise<unknown> {
    const url = this.buildUrl(path);
    const res = await this.requestOk('PUT', url, {
      body: encodeForm(params),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return this.parseJson(res, url);
  }

  async putJson(path: string, body: unknown): Promise<unknown> {
    const url = this.buildUrl(path);
    const res = await this.requestOk('PUT', url, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    return this.parseJson(res, url);
  }

  /** DELETE that throws on failure; response body is drained, not parsed. */
  async deleteOk(path: string): Promise<void> {
    const url = this.buildUrl(path);
    const res = await this.requestOk('DELETE', url);
    await drainResponse(res);
  }
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return Math.min(1000 * 2 ** attempt + jitter(), 30_000);
}

function jitter(): number {
  return Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
