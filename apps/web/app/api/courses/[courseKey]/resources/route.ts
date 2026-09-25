// /api/courses/[courseKey]/resources — grading materials (template/key) +
// per-assignment prep settings, stored in the course's hidden Canvas folder
// by the engine (the web tier never touches Canvas).
//
//   GET    ?assignmentId=              → { prep, resources } (grading session)
//   PUT    { assignmentId, prep }      → save prep settings (course staff)
//   POST   multipart form: file, kind, assignmentId, assignmentName
//                                      → upload material, ≤ 15 MB (staff)
//   DELETE ?assignmentId=&kind=        → remove material (course staff)

import { NextResponse, type NextRequest } from 'next/server';
import { browserMutationGuard } from '../../../../../lib/auth/local-session';
import { z } from 'zod';
import {
  requireCourseStaff,
  requireGradingContext,
} from '../../../../../lib/auth/resolve-context';
import {
  courseEngineParams,
  resolveCourseAccess,
} from '../../../../../lib/courses/course-api';
import { proxyResponse } from '../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Mirror of the engine's cap — enforced here too so an oversize file fails
 * fast instead of riding a 13 MB base64 hop just to be refused. */
const MAX_MATERIAL_BYTES = 15 * 1024 * 1024;

type Params = { params: Promise<{ courseKey: string }> };

function parseAssignmentId(value: string | null): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest, { params }: Params) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireGradingContext);
  if (!access.ok) return access.response;

  const assignmentId = parseAssignmentId(req.nextUrl.searchParams.get('assignmentId'));
  if (assignmentId === null) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'assignmentId query parameter is required.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/resources/get', {
    ...courseEngineParams(access.ctx),
    assignmentId,
  });
  return proxyResponse(result);
}

const prepBody = z.object({
  assignmentId: z.number().int().positive(),
  prep: z.object({}).passthrough(),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  const parsed = prepBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'assignmentId and prep are required.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/resources/prep', {
    ...courseEngineParams(access.ctx),
    assignmentId: parsed.data.assignmentId,
    prep: parsed.data.prep,
  });
  return proxyResponse(result);
}

export async function POST(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req, { accept: ['multipart'] });
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Expected a multipart form upload.' },
      { status: 400 },
    );
  }

  const file = form.get('file');
  const kind = String(form.get('kind') ?? '');
  const assignmentId = parseAssignmentId(String(form.get('assignmentId') ?? ''));
  const assignmentName = String(form.get('assignmentName') ?? '');

  if (!(file instanceof File) || assignmentId === null || !['TEMPLATE', 'KEY'].includes(kind)) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'file, kind (TEMPLATE|KEY), and assignmentId are required.' },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'The uploaded file is empty.' },
      { status: 400 },
    );
  }
  if (file.size > MAX_MATERIAL_BYTES) {
    return NextResponse.json(
      { error: 'file_too_large', message: 'Materials are capped at 15 MB.' },
      { status: 413 },
    );
  }

  const bytesBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  const result = await engineFetch('/course/resources/upload', {
    ...courseEngineParams(access.ctx),
    assignmentId,
    assignmentName,
    kind,
    filename: file.name || 'upload.bin',
    contentType: file.type || 'application/octet-stream',
    bytesBase64,
  });
  return proxyResponse(result);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req, { accept: ['empty', 'json'] });
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  const assignmentId = parseAssignmentId(req.nextUrl.searchParams.get('assignmentId'));
  const kind = req.nextUrl.searchParams.get('kind') ?? '';
  if (assignmentId === null || !['TEMPLATE', 'KEY'].includes(kind)) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'assignmentId and kind (TEMPLATE|KEY) query parameters are required.' },
      { status: 400 },
    );
  }

  const result = await engineFetch('/course/resources/delete', {
    ...courseEngineParams(access.ctx),
    assignmentId,
    kind,
  });
  return proxyResponse(result);
}
