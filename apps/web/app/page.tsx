// The local home page. With a review session (the browser followed a
// single-use link the local server opened), go straight to the course
// picker; without one, explain how to open the grader from Codex.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { EngineUnavailableError, getLocalHost } from '../lib/engine/client';
import './connect/connect.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REASONS: Record<string, string> = {
  'no-session':
    'Your review session has ended or this browser has not been signed in yet.',
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  let hasSession = false;
  try {
    const host = getLocalHost();
    const jar = await cookies();
    hasSession = host.verifySession(jar.get(host.sessionCookieName)?.value);
  } catch (err) {
    if (!(err instanceof EngineUnavailableError)) throw err;
  }
  if (hasSession) redirect('/connect');

  return (
    <div className="connect">
      <nav className="connect-nav">
        <span className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/aigrader-white-square.png" alt="" aria-hidden />
          <span>BYU-(A)I Grader</span>
        </span>
      </nav>
      <main className="connect-card">
        <h1>Open the grader from Codex</h1>
        {reason && REASONS[reason] ? <p className="sub">{REASONS[reason]}</p> : null}
        <p className="sub">
          BYU-(A)I Grader runs on your own computer. For your security, this review page
          only opens through a one-time link that the grader creates for you.
        </p>
        <div className="connect-help">
          <strong>To open it:</strong>
          <ol>
            <li>
              In Codex, ask: <em>&ldquo;Open the AI Grader review page.&rdquo;</em>
            </li>
            <li>
              Or, in a terminal, run <code>aigrader open</code>.
            </li>
          </ol>
        </div>
        <p className="sub" style={{ marginBottom: 0 }}>
          The AI drafts scores and feedback. You review every draft here, and nothing posts
          to Canvas until you approve it.
        </p>
      </main>
      <p className="connect-footer">BYU-Idaho · Instructional Technology</p>
    </div>
  );
}
