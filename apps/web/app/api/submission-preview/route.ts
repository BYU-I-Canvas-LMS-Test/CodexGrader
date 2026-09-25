// POST /api/submission-preview — the in-app viewer's JSON side: the
// submission descriptor (attachment tabs + sanitized text-entry body) and the
// server-side conversions (DOCX/RTF → sanitized HTML, spreadsheet grid JSON,
// quiz full-answer HTML). Engine-relayed; course staff only (the same
// boundary as the review screen's run snapshot). ALL HTML in these payloads
// was sanitized engine-side by @aigrader/extraction's allowlist sanitizer — the
// web tier never sanitizes and never converts.
//
// Body: { courseKey, kind, … } where kind is
//   'submission'                → /preview/submission {assignmentId, userId}
//   'preview' | 'docx-html'
//     | 'rtf-html' | 'grid'     → /preview/convert {…, attachmentId,
//                                  sheetIndex?, showFormulas?, allRows?}
//   'quiz-answer'               → /preview/quiz-answer {quizSubmissionId,
//                                  questionId}

import { NextResponse, type NextRequest } from 'next/server';
import { requireCourseStaff } from '../../../lib/auth/resolve-context';
import { courseEngineParams, resolveCourseAccess } from '../../../lib/courses/course-api';
import { proxyResponse } from '../../../lib/runs/run-access';
import { engineFetch } from '../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONVERT_KINDS = new Set(['preview', 'docx-html', 'rtf-html', 'grid']);

function bad(message: string): NextResponse {
  return NextResponse.json({ error: 'invalid_request', message }, { status: 400 });
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad('A JSON body is required.');

  const courseKey = typeof body.courseKey === 'string' ? body.courseKey : null;
  const kind = typeof body.kind === 'string' ? body.kind : null;
  if (!courseKey || !kind) return bad('courseKey and kind are required.');

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;
  const base = courseEngineParams(access.ctx);

  if (kind === 'quiz-answer') {
    const quizSubmissionId = positiveInt(body.quizSubmissionId);
    const questionId = positiveInt(body.questionId);
    if (quizSubmissionId === null || questionId === null) {
      return bad('quizSubmissionId and questionId are required.');
    }
    return proxyResponse(
      await engineFetch('/preview/quiz-answer', { ...base, quizSubmissionId, questionId }),
    );
  }

  const assignmentId = positiveInt(body.assignmentId);
  const userId = positiveInt(body.userId);
  if (assignmentId === null || userId === null) {
    return bad('assignmentId and userId are required.');
  }

  if (kind === 'submission') {
    return proxyResponse(
      await engineFetch('/preview/submission', { ...base, assignmentId, userId }),
    );
  }

  if (!CONVERT_KINDS.has(kind)) return bad(`Unknown kind '${kind}'.`);
  const attachmentId = positiveInt(body.attachmentId);
  if (attachmentId === null) return bad('attachmentId is required.');

  return proxyResponse(
    await engineFetch('/preview/convert', {
      ...base,
      assignmentId,
      userId,
      attachmentId,
      kind,
      sheetIndex:
        typeof body.sheetIndex === 'number' && Number.isInteger(body.sheetIndex) && body.sheetIndex >= 0
          ? body.sheetIndex
          : 0,
      showFormulas: body.showFormulas === true,
      allRows: body.allRows === true,
    }),
  );
}
