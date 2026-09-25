// GET /api/submission-file/[assignmentId]/[userId]/[attachmentId]?courseKey=
// [&download=true] — the in-app viewer's same-origin file streaming proxy
// (the browser's <img>/<iframe>/<a> requests carry the session cookie).
//
// Contract, ported from C:\Devs\AIGrader-C#\src\AiGrader\Controllers\
// SubmissionFileController.cs onto this app's auth: the client only ever
// names IDS — the course comes from the caller's GradingContext (course
// staff only, same boundary as the run snapshot the review screen already
// requires), and the ENGINE re-resolves a fresh Canvas signed URL after
// verifying the attachment belongs to that student's submission in that
// course. No client-supplied URL is ever fetched — SSRF and cross-course
// access are ruled out by construction.
//
// Security headers (lib/viewing/file-headers.ts): inline content types are
// re-checked against the PDF+image allowlist here (defense in depth over the
// worker's own classification); everything else ships as octet-stream +
// attachment disposition; always nosniff; Cache-Control private. The engine's
// byte stream is PIPED through (engineFetchRaw) — never buffered as base64.

import { NextResponse, type NextRequest } from 'next/server';
import { requireCourseStaff } from '../../../../../../lib/auth/resolve-context';
import {
  courseEngineParams,
  resolveCourseAccess,
} from '../../../../../../lib/courses/course-api';
import { buildFileResponseHeaders } from '../../../../../../lib/viewing/file-headers';
import { engineFetchRaw } from '../../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = {
  params: Promise<{ assignmentId: string; userId: string; attachmentId: string }>;
};

function positiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: NextRequest, { params }: Params) {
  const raw = await params;
  const assignmentId = positiveInt(raw.assignmentId);
  const userId = positiveInt(raw.userId);
  const attachmentId = positiveInt(raw.attachmentId);
  const courseKey = req.nextUrl.searchParams.get('courseKey');
  if (assignmentId === null || userId === null || attachmentId === null || !courseKey) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'assignmentId/userId/attachmentId and courseKey are required.' },
      { status: 400 },
    );
  }

  const access = await resolveCourseAccess(decodeURIComponent(courseKey), requireCourseStaff);
  if (!access.ok) return access.response;

  const download = req.nextUrl.searchParams.get('download') === 'true';
  const res = await engineFetchRaw('/preview/file', {
    ...courseEngineParams(access.ctx),
    assignmentId,
    userId,
    attachmentId,
    download,
  });

  if (!res.ok) {
    // Engine errors are small JSON bodies (404/413/502) — relay them.
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return NextResponse.json(
      body ?? { error: 'preview_failed', message: `Engine replied ${res.status}.` },
      { status: res.status },
    );
  }

  const headers = buildFileResponseHeaders({
    workerContentType: res.headers.get('content-type'),
    filename: decodeURIComponent(res.headers.get('x-preview-filename') ?? '') || 'file',
    download,
    size: res.headers.get('x-preview-size'),
  });
  // Stream the engine's body straight through — no buffering.
  return new NextResponse(res.body, { status: 200, headers });
}
