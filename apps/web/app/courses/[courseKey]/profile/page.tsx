// Course AI Profile (M4) — thin server component over the 4-step wizard.

import { redirect } from 'next/navigation';
import { getGradingContext } from '../../../../lib/auth/resolve-context';
import { CreateProfileView } from './create-profile-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ courseKey: string }>;
}) {
  const { courseKey: rawKey } = await params;
  const courseKey = decodeURIComponent(rawKey);

  const ctx = await getGradingContext(courseKey);
  if (!ctx) redirect('/signin');

  return <CreateProfileView courseKey={courseKey} isStaff={ctx.isCourseStaff} />;
}
