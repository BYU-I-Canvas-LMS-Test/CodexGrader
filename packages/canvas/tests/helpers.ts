// Shared fetch-mocking helpers for the @aigrader/canvas test suites.

export type RecordedCall = {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
  redirect: RequestInit['redirect'];
};

export type MockResponder = Response | ((url: string, init?: RequestInit) => Response);

/**
 * A queue-based fetch mock: each call consumes the next responder and records
 * the request (URL, method, normalized headers, body, redirect mode).
 */
export function makeFetch(responses: MockResponder[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected fetch call: ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetchImpl, calls };
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function textResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

export function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}
