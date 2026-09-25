// The browser side of the local review session.
//
// A session exists only after the teacher's browser follows a single-use,
// short-lived login URL that the LOCAL SERVER itself opened in the system
// browser (`aigrader open`, or the MCP tool `request_posting`). The login
// route below trades that token for an HttpOnly, SameSite=Strict session
// cookie plus a readable CSRF cookie the page echoes back as a header.
//
// browserMutationGuard is the human-in-the-loop fence for the review page's
// mutations — above all APPROVE. It requires, all at once:
//   1. a valid session cookie,
//   2. the CSRF header matching this session's CSRF token,
//   3. Origin exactly equal to the server's own origin,
//   4. Sec-Fetch-Site: same-origin (browsers set it; scripts must forge it),
//   5. Content-Type: application/json.
// (1)–(2) stop anything that never held the browser session — e.g. an agent
// calling localhost with curl; (3)–(5) stop other web pages in the browser.

import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { getLocalHost } from '../engine/client';

/** Readable (non-HttpOnly) cookie carrying this session's CSRF token. */
export const CSRF_COOKIE = 'aigrader_csrf';
/** Header the page echoes the CSRF token in. */
export const CSRF_HEADER = 'x-aigrader-csrf';

/** True when the request carries a valid browser session cookie. */
export function hasLocalSession(req: NextRequest): boolean {
  const host = getLocalHost();
  return host.verifySession(req.cookies.get(host.sessionCookieName)?.value);
}

function refuse(message: string): NextResponse {
  return NextResponse.json({ error: 'forbidden', message }, { status: 403 });
}

/** Request body formats a guarded route accepts ('empty' = no body, e.g.
 * cancel/resume/DELETE). JSON is the default. */
export type GuardedBody = 'json' | 'multipart' | 'empty';

/** Returns a 403 response when the mutation did not come from the review
 * page in the teacher's browser; null when it may proceed. EVERY mutating
 * route calls it (tests/mutation-guard-coverage.test.ts enforces that). */
export function browserMutationGuard(
  req: NextRequest,
  opts: { accept?: GuardedBody[] } = {},
): NextResponse | null {
  const host = getLocalHost();
  const session = req.cookies.get(host.sessionCookieName)?.value;
  if (!host.verifySession(session)) {
    return refuse('Open the review page from Codex (or `aigrader open`) to make changes.');
  }
  const csrf = req.headers.get(CSRF_HEADER);
  if (!csrf || csrf !== host.csrfTokenFor(session!)) {
    return refuse('This change must be made from the review page.');
  }
  if (req.headers.get('origin') !== host.origin) {
    return refuse('This change must be made from the review page.');
  }
  if (req.headers.get('sec-fetch-site') !== 'same-origin') {
    return refuse('This change must be made from the review page.');
  }
  const accept = opts.accept ?? ['json'];
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  const format: GuardedBody | null = contentType.startsWith('application/json')
    ? 'json'
    : contentType.startsWith('multipart/form-data')
      ? 'multipart'
      : contentType === '' && !hasBody(req)
        ? 'empty'
        : null;
  if (format == null || !accept.includes(format)) {
    return refuse('Unsupported request format.');
  }
  host.noteActivity();
  return null;
}

function hasBody(req: NextRequest): boolean {
  const length = req.headers.get('content-length');
  if (length != null) return Number(length) > 0;
  return req.headers.get('transfer-encoding') != null;
}
