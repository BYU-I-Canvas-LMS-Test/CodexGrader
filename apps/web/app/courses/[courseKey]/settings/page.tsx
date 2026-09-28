// Grader Settings — thin server component over the settings form. The
// settings belong to this computer (every course), not to the course; the
// course layout has already confirmed the review session.

import { SettingsView } from './settings-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ courseKey: string }>;
}) {
  const { courseKey: rawKey } = await params;
  return <SettingsView courseKey={decodeURIComponent(rawKey)} />;
}
