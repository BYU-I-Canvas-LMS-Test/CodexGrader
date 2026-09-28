// /api/settings — Grader Settings for this computer: how many students Codex
// grades at once, which model, and the thinking level. The local server owns
// them (~/.aigrader/settings.json) and applies a change without a restart;
// the web tier relays through lib/engine/client.ts.
//
//   GET → { settings, activeModel, defaultModel, models, reasoningEfforts,
//           workers, codex }                         (review session required)
//   PUT { model?, reasoningEffort?, maxWorkers? } → the same view, or
//        400 { error: 'invalid_settings', message }

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { browserMutationGuard, hasLocalSession } from '../../../lib/auth/local-session';
import { getGradingSettings, saveGradingSettings } from '../../../lib/engine/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateSchema = z
  .object({
    model: z.string().max(100).optional(),
    reasoningEffort: z.string().max(16).optional(),
    maxWorkers: z.number().int().optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  if (!hasLocalSession(req)) {
    return NextResponse.json(
      {
        error: 'no_session',
        message: 'Open the grader from Codex (or run `aigrader open`) to start a review session.',
      },
      { status: 401 },
    );
  }
  return NextResponse.json(await getGradingSettings());
}

export async function PUT(req: NextRequest) {
  const refused = browserMutationGuard(req);
  if (refused) return refused;

  const parsed = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_settings', message: 'The request body must be a settings object.' },
      { status: 400 },
    );
  }
  const result = await saveGradingSettings(parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: 'invalid_settings', message: result.message }, { status: 400 });
  }
  return NextResponse.json(result.view);
}
