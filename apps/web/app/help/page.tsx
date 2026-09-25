// Public /help route — the landing page links here for visitors who have no
// session yet. The walkthrough itself is fully static (no course context),
// so it renders the course-shell help page verbatim; signed-in users see the
// identical content inside the sidebar shell at /courses/:courseKey/help.
// (Next.js forbids re-exporting segment config, so it's declared locally.)
import HelpPage from '../courses/[courseKey]/help/page';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

export default HelpPage;
