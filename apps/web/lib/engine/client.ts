// In-process calls from the web tier to the grading engine. Every server-side
// Canvas/run operation goes through engineFetch — the web tier never talks to
// Canvas itself. The engine is NOT on the network: the local server (the one
// `aigrader serve` process) installed a LocalHost on globalThis before Next
// started, and these helpers dispatch through it in memory.
//
// Returns { status, body } WITHOUT throwing on non-2xx — callers relay the
// engine's error contract (422 invalid_token, 403 not_course_staff, …) onto
// their own responses. Throws EngineUnavailableError only when the page is
// served by something other than `aigrader serve` (e.g. a bare `next dev`).

import 'server-only';

import { LOCAL_HOST_GLOBAL, type EngineDispatchResponse, type LocalHost } from '@aigrader/shared';

export interface EngineResponse {
  status: number;
  body: unknown;
}

/** The page isn't running inside the local server. */
export class EngineUnavailableError extends Error {
  constructor() {
    super(
      'The local grading engine is not running. Start the tool with `aigrader serve` (Codex does this for you).',
    );
    this.name = 'EngineUnavailableError';
  }
}

/** The LocalHost the server installed (throws when absent). */
export function getLocalHost(): LocalHost {
  const host = (globalThis as Record<string, unknown>)[LOCAL_HOST_GLOBAL] as LocalHost | undefined;
  if (!host) throw new EngineUnavailableError();
  return host;
}

function decodeJson(result: EngineDispatchResponse): EngineResponse {
  const text = new TextDecoder().decode(result.body);
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { error: 'bad_engine_response', message: text.slice(0, 200) };
    }
  }
  return { status: result.status, body: parsed };
}

/**
 * Calls the in-process engine at `path` (must start with '/'). Defaults to
 * POSTing `body` as JSON; pass `{ method: 'GET' }` for read endpoints (query
 * params ride in `path`). The engine reached this way CANNOT approve grades.
 */
export async function engineFetch(
  path: string,
  body: unknown,
  opts: { method?: 'GET' | 'POST' } = {},
): Promise<EngineResponse> {
  const method = opts.method ?? 'POST';
  const result = await getLocalHost().engine({
    method,
    url: path,
    ...(method === 'POST' ? { body } : {}),
  });
  return decodeJson(result);
}

/**
 * Like engineFetch, but returns a web Response carrying the engine's raw
 * bytes and headers — for binary endpoints (/preview/file) the viewer's file
 * proxy passes straight through. Callers own status handling.
 */
export async function engineFetchRaw(
  path: string,
  body: unknown,
  opts: { method?: 'GET' | 'POST' } = {},
): Promise<Response> {
  const method = opts.method ?? 'POST';
  const result = await getLocalHost().engine({
    method,
    url: path,
    ...(method === 'POST' ? { body } : {}),
  });
  return new Response(result.body.byteLength > 0 ? Buffer.from(result.body) : null, {
    status: result.status,
    headers: result.headers,
  });
}

/**
 * THE approval path — the only call in the web tier that can approve grades.
 * Use it ONLY from the browser-guarded approve route, after its session,
 * CSRF, and origin checks pass (lib/runs/approve-guard.ts).
 */
export async function engineApprove(runId: string, body: unknown): Promise<EngineResponse> {
  return decodeJson(await getLocalHost().approve(runId, body));
}
