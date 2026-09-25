// /api/courses/[courseKey]/alignment/outcomes — course outcome management +
// account outcome-library browsing (the engine owns all Canvas I/O).
//
//   GET ?list=course                       → { outcomes } (course outcomes;
//                                            the engine also syncs them into
//                                            the AI Profile's outcome refs)
//   GET ?list=library                      → { accountId, group, subgroups,
//                                            outcomes } (library root level)
//   GET ?list=library&groupId=&accountId=  → { accountId, subgroups, outcomes }
//                                            (one lazily-expanded level)
//   POST { action:'link'|'unlink', outcomeId }        → { outcomes }  (staff)
//   POST { action:'create', title, description? }     → { outcome, outcomes } (staff)

import { NextResponse, type NextRequest } from 'next/server';
import { browserMutationGuard } from '../../../../../../lib/auth/local-session';
import { z } from 'zod';
import {
  requireCourseStaff,
  requireGradingContext,
} from '../../../../../../lib/auth/resolve-context';
import {
  actorParams,
  courseEngineParams,
  resolveCourseAccess,
} from '../../../../../../lib/courses/course-api';
import { proxyResponse } from '../../../../../../lib/runs/run-access';
import { engineFetch } from '../../../../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ courseKey: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireGradingContext);
  if (!access.ok) return access.response;
  const base = courseEngineParams(access.ctx);

  const list = req.nextUrl.searchParams.get('list') ?? 'course';

  if (list === 'course') {
    return proxyResponse(await engineFetch('/alignment/outcomes/course-list', base));
  }
  if (list !== 'library') {
    return NextResponse.json(
      { error: 'invalid_request', message: "list must be 'course' or 'library'." },
      { status: 400 },
    );
  }

  const groupIdRaw = req.nextUrl.searchParams.get('groupId');
  const accountIdRaw = req.nextUrl.searchParams.get('accountId');

  // Root level: resolve the account + root group first, then list its
  // contents; deeper levels list the requested group directly.
  let accountId = accountIdRaw ? Number(accountIdRaw) : undefined;
  let groupId = groupIdRaw ? Number(groupIdRaw) : undefined;
  let group: unknown = null;
  if (groupId === undefined) {
    const root = await engineFetch('/alignment/outcomes/library-root', base);
    if (root.status !== 200) return proxyResponse(root);
    const body = root.body as { accountId: number; group: { id: number; title: string } };
    accountId = body.accountId;
    groupId = body.group.id;
    group = body.group;
  } else if (!Number.isInteger(groupId) || groupId <= 0) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'groupId must be a positive integer.' },
      { status: 400 },
    );
  }

  const scoped = { ...base, groupId, ...(accountId ? { accountId } : {}) };
  const [subgroups, outcomes] = await Promise.all([
    engineFetch('/alignment/outcomes/library-subgroups', scoped),
    engineFetch('/alignment/outcomes/library-outcomes', scoped),
  ]);
  if (subgroups.status !== 200) return proxyResponse(subgroups);
  if (outcomes.status !== 200) return proxyResponse(outcomes);

  return NextResponse.json({
    accountId: (subgroups.body as { accountId: number }).accountId,
    group,
    subgroups: (subgroups.body as { subgroups: unknown[] }).subgroups,
    outcomes: (outcomes.body as { outcomes: unknown[] }).outcomes,
  });
}

const postBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), outcomeId: z.number().int().positive() }),
  z.object({ action: z.literal('unlink'), outcomeId: z.number().int().positive() }),
  z.object({
    action: z.literal('create'),
    title: z.string().min(1).max(300),
    description: z.string().max(5000).optional(),
  }),
]);

export async function POST(req: NextRequest, { params }: Params) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const access = await resolveCourseAccess(courseKey, requireCourseStaff);
  if (!access.ok) return access.response;

  const parsed = postBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        message: "action must be 'link', 'unlink' (with outcomeId), or 'create' (with title).",
      },
      { status: 400 },
    );
  }

  const base = { ...courseEngineParams(access.ctx), ...actorParams(access.ctx) };
  const body = parsed.data;
  const result =
    body.action === 'create'
      ? await engineFetch('/alignment/outcomes/create', {
          ...base,
          title: body.title,
          description: body.description ?? '',
        })
      : await engineFetch(`/alignment/outcomes/${body.action}`, {
          ...base,
          outcomeId: body.outcomeId,
        });
  return proxyResponse(result);
}
