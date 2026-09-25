// Shared test helpers for the worker suites: a queue-based fetch mock
// (mirrors packages/canvas/tests/helpers.ts) and an ephemeral-port Express
// harness so route tests exercise real HTTP.

import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedCall = {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
};

export type MockResponder = Response | ((url: string, init?: RequestInit) => Response);

/** Queue-based fetch mock: each call consumes the next responder and records
 * the request. */
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
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

/** Runs `fn` against an app listening on an ephemeral port, then closes it. */
export async function withServer<T>(
  app: Express,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

/** POST JSON helper for route tests. */
export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}
