// GET /session/start?token=…&next=/courses/… — redeems the single-use login
// token the local server put in the URL it opened in the system browser,
// sets the session cookie (HttpOnly, SameSite=Strict) and the readable CSRF
// cookie, then redirects to `next` (same-origin paths only).
//
// The token is useless after one redemption or ~30 seconds; it never appears
// in any tool output, so an agent can't replay it.

import { NextResponse, type NextRequest } from 'next/server';
import { getLocalHost } from '../../../lib/engine/client';
import { CSRF_COOKIE } from '../../../lib/auth/local-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only same-origin absolute paths — never a scheme, host, or "//evil". */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

export async function GET(req: NextRequest) {
  const host = getLocalHost();
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const session = host.redeemLoginToken(token);
  if (!session) {
    return new NextResponse(
      'This review link has expired. Ask Codex to open the review page again (or run `aigrader open`).',
      { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const res = NextResponse.redirect(new URL(safeNext(req.nextUrl.searchParams.get('next')), host.origin));
  // 127.0.0.1 is plain http, so no Secure flag; SameSite=Strict + HttpOnly.
  res.cookies.set(host.sessionCookieName, session, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  });
  res.cookies.set(CSRF_COOKIE, host.csrfTokenFor(session), {
    httpOnly: false,
    sameSite: 'strict',
    path: '/',
  });
  host.noteActivity();
  return res;
}
