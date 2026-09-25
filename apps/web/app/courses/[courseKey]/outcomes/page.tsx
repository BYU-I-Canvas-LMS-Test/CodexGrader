// Outcomes & Alignment (M6) — thin server component: resolves the
// GradingContext (shared with the layout via React cache()) and hands off to
// the client view. Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\
// Pages\OutcomesAlignment.razor via the TS predecessor's outcomes-view.tsx.

import { redirect } from 'next/navigation';
import { getGradingContext } from '../../../../lib/auth/resolve-context';
import { OutcomesView } from './outcomes-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function OutcomesPage({
  params,
}: {
  params: Promise<{ courseKey: string }>;
}) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const ctx = await getGradingContext(courseKey);
  if (!ctx) redirect('/signin'); // layout already gates; belt and braces

  return <OutcomesView courseKey={courseKey} isStaff={ctx.isCourseStaff} />;
}
