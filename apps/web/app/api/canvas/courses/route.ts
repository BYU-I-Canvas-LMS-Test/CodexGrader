// The local course picker's data. The web tier relays to the in-process
// engine — it never calls Canvas itself.
//
//   GET  — every configured Canvas instance (from ~/.aigrader/.env) with the
//          teacher's name there and the courses they can grade
//          (teacher/ta/designer).
//          → { instances: [{ host, baseUrl, canvasUserName, courses, error? }] }
//          409 {error:'not_configured'} when the .env has no token yet.
//   POST { host, courseId } — verify an ACTIVE teacher/ta/designer seat in
//          that course (Canvas is the authority) → { courseKey }.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { makeCourseKey } from '@aigrader/shared';
import { hasLocalSession } from '../../../../lib/auth/local-session';
import { engineFetch } from '../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noSession = () =>
  NextResponse.json(
    {
      error: 'no_session',
      message: 'Open the grader from Codex (or run `aigrader open`) to start a review session.',
    },
    { status: 401 },
  );

interface InstanceRow {
  host: string;
  baseUrl: string;
}

export async function GET(req: NextRequest) {
  if (!hasLocalSession(req)) return noSession();

  const instancesRes = await engineFetch('/canvas/instances', null, { method: 'GET' });
  const instances = ((instancesRes.body as { instances?: InstanceRow[] })?.instances ?? []);
  if (instances.length === 0) {
    return NextResponse.json(
      {
        error: 'not_configured',
        message:
          'No Canvas access token is configured yet. Add CANVAS_BASE_URL and CANVAS_API_TOKEN to ~/.aigrader/.env (run `aigrader config`).',
      },
      { status: 409 },
    );
  }

  const rows = [];
  for (const instance of instances) {
    const [who, list] = await Promise.all([
      engineFetch('/canvas/whoami', { apiDomain: instance.host }),
      engineFetch('/canvas/courses/list', { apiDomain: instance.host }),
    ]);
    if (list.status !== 200) {
      rows.push({
        ...instance,
        canvasUserName: null,
        courses: [],
        error: (list.body as { message?: string } | null)?.message ?? 'Could not load courses.',
      });
      continue;
    }
    rows.push({
      ...instance,
      canvasUserName:
        who.status === 200 ? ((who.body as { canvasUserName?: string }).canvasUserName ?? null) : null,
      courses: (list.body as { courses: unknown[] }).courses,
    });
  }
  return NextResponse.json({ instances: rows });
}

const PostSchema = z.object({
  host: z.string().min(1),
  courseId: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/)]),
});

export async function POST(req: NextRequest) {
  if (!hasLocalSession(req)) return noSession();

  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Pick a course first.' },
      { status: 400 },
    );
  }
  const courseId = String(parsed.data.courseId);

  const result = await engineFetch('/canvas/courses/verify', {
    apiDomain: parsed.data.host,
    courseId,
  });
  if (result.status === 403) {
    return NextResponse.json(
      {
        error: 'not_course_staff',
        message:
          'Canvas does not list you as a teacher, TA, or designer in that course, so it cannot be opened here.',
      },
      { status: 403 },
    );
  }
  if (result.status !== 200) {
    return NextResponse.json(
      (result.body as Record<string, unknown>) ?? {
        error: 'engine_error',
        message: 'Could not verify the course with Canvas.',
      },
      { status: result.status >= 400 ? result.status : 502 },
    );
  }

  return NextResponse.json({ courseKey: makeCourseKey(parsed.data.host, courseId) });
}
