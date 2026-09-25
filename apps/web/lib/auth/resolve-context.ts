// Resolves the request's GradingContext for a course.
//
// Resolution:
//   1. The browser session cookie must be valid (minted only through a
//      single-use login URL the local server opened in the system browser —
//      see LocalHost.redeemLoginToken). No cookie → null → 401.
//   2. The course key must name a Canvas instance the teacher configured.
//   3. The engine confirms the teacher's own Canvas account holds an ACTIVE
//      teacher/TA/designer enrollment in that course (Canvas is the
//      authority), and supplies the teacher's display name.
// Identity + staff answers are cached briefly so page renders don't re-ask
// Canvas on every request.

import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import { parseCourseKey } from '@aigrader/shared';
import { engineFetch, getLocalHost } from '../engine/client';
import { HttpError, type GradingContext } from '../context/grading-context';

const CACHE_TTL_MS = 5 * 60 * 1000;

type StaffAnswer =
  | { ok: true; enrollmentRole: string; courseName: string }
  | { ok: false; status: number; message: string };

const staffCache = new Map<string, { at: number; answer: StaffAnswer }>();
const whoCache = new Map<string, { at: number; name: string; canvasUserId: string }>();

function fresh<T extends { at: number }>(entry: T | undefined): T | undefined {
  return entry && Date.now() - entry.at < CACHE_TTL_MS ? entry : undefined;
}

async function staffAnswer(host: string, courseId: number, courseKey: string): Promise<StaffAnswer> {
  const hit = fresh(staffCache.get(courseKey));
  if (hit) return hit.answer;
  const res = await engineFetch('/canvas/courses/verify', { apiDomain: host, courseId });
  const body = (res.body ?? {}) as { enrollmentRole?: string; courseName?: string; message?: string };
  const answer: StaffAnswer =
    res.status === 200
      ? { ok: true, enrollmentRole: body.enrollmentRole ?? 'teacher', courseName: body.courseName ?? '' }
      : {
          ok: false,
          status: res.status === 403 ? 403 : res.status,
          message: body.message ?? 'Canvas could not confirm your access to this course.',
        };
  // Only cache definitive answers (not transient Canvas failures).
  if (answer.ok || res.status === 403) staffCache.set(courseKey, { at: Date.now(), answer });
  return answer;
}

async function whoAmI(host: string): Promise<{ name: string; canvasUserId: string } | null> {
  const hit = fresh(whoCache.get(host));
  if (hit) return hit;
  const res = await engineFetch('/canvas/whoami', { apiDomain: host });
  if (res.status !== 200) return null;
  const body = res.body as { canvasUserName?: string; canvasUserId?: string };
  const entry = {
    at: Date.now(),
    name: body.canvasUserName ?? 'Instructor',
    canvasUserId: String(body.canvasUserId ?? ''),
  };
  whoCache.set(host, entry);
  return entry;
}

/** Drops cached identity/staff answers (after a token rotation). */
export function clearContextCaches(): void {
  staffCache.clear();
  whoCache.clear();
}

type Resolution =
  | { kind: 'ok'; ctx: GradingContext }
  | { kind: 'no_session' }
  | { kind: 'refused'; status: number; message: string };

async function resolve(courseKey: string): Promise<Resolution> {
  let parsed;
  try {
    parsed = parseCourseKey(courseKey);
  } catch {
    return { kind: 'no_session' };
  }

  const host = getLocalHost();
  const jar = await cookies();
  if (!host.verifySession(jar.get(host.sessionCookieName)?.value)) {
    return { kind: 'no_session' };
  }
  host.noteActivity();

  const courseId = Number(parsed.courseId);
  const staff = await staffAnswer(parsed.host, courseId, courseKey);
  if (!staff.ok) return { kind: 'refused', status: staff.status, message: staff.message };

  const who = await whoAmI(parsed.host);
  return {
    kind: 'ok',
    ctx: {
      authSource: 'local',
      user: { displayName: who?.name ?? 'Instructor', canvasUserId: who?.canvasUserId || undefined },
      canvasBaseUrl: `https://${parsed.host}`,
      courseId: String(courseId),
      courseKey,
      courseName: staff.courseName || `Course ${courseId}`,
      roles: [staff.enrollmentRole],
      isCourseStaff: true,
    },
  };
}

const resolveCached = cache(resolve);

/** Per-request memoized resolver — null when there is no valid session or
 * the teacher isn't staff in the course. */
export const getGradingContext = cache(async (courseKey: string): Promise<GradingContext | null> => {
  const r = await resolveCached(courseKey);
  return r.kind === 'ok' ? r.ctx : null;
});

/** Resolve or throw an HttpError (401 no session / 403 not staff / other). */
export async function requireGradingContext(courseKey: string): Promise<GradingContext> {
  const r = await resolveCached(courseKey);
  if (r.kind === 'ok') return r.ctx;
  if (r.kind === 'refused') throw new HttpError(r.status, r.message);
  throw new HttpError(
    401,
    'No review session. Ask Codex to open the review page, or run `aigrader open`.',
  );
}

/** Resolve, then enforce the faculty boundary (403 on non-staff). */
export async function requireCourseStaff(courseKey: string): Promise<GradingContext> {
  const ctx = await requireGradingContext(courseKey);
  if (!ctx.isCourseStaff) {
    throw new HttpError(403, 'This tool is limited to course staff.');
  }
  return ctx;
}
