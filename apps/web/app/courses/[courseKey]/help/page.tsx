// Help & Resources (M6) — the faculty walkthrough ("field guide").
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Pages\Help.razor
// (chapter structure, benefits-first copy, plates, FAQ), adjusted to
// describe ONLY this tool's shipped behavior: it runs on the teacher's own
// computer and is driven from Codex, the alignment chapter matches the
// three-tab Outcomes & Alignment page (including the in-app rubric editor),
// and approval happens only here in the review page.
// Each plate renders a styled "screenshot coming soon" placeholder with the
// original caption until new screenshots are captured. The C# scrollspy/
// lightbox/reveal JS is dropped; the rail is plain anchor navigation.

import './help.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPPORT_EMAIL = 'instructionaltechnology@byui.edu';

/** The exact posted-comment prefix (a parity contract with the C# app). */
const REVIEWED_PREFIX = '[As Reviewed by {name}]';

/** A screenshot "plate": browser-style chrome bar + placeholder + caption
 * (a coming-soon treatment until new screenshots are captured). */
function Plate({ where, title, caption }: { where: string; title: string; caption: string }) {
  return (
    <figure className="plate">
      <div className="plate-bar">
        <i />
        <i />
        <i />
        <span className="plate-where">{where}</span>
      </div>
      <div className="plate-placeholder" role="img" aria-label={`${title}: ${caption}`}>
        <span className="pp-badge">Screenshot coming soon</span>
        <span className="pp-hint">{where}</span>
      </div>
      <figcaption className="plate-caption">
        <b>{title}.</b> {caption}
      </figcaption>
    </figure>
  );
}

const CHAPTERS = [
  ['launch', '1', 'Get started'],
  ['dashboard', '2', 'Dashboard'],
  ['profile', '3', 'AI Profile'],
  ['alignment', '4', 'Alignment'],
  ['prepare', '5', 'Prepare'],
  ['run', '6', 'Run & Review'],
  ['post', '7', 'Approve & Post'],
  ['resume', '8', 'Resume'],
  ['types', '9', "What's gradable"],
  ['faq', '?', 'FAQ'],
] as const;

export default async function HelpPage({
  params,
}: {
  params: Promise<{ courseKey: string }>;
}) {
  await params; // course-scoped route; content is course-independent

  return (
    <div className="help" id="top">
      {/* ============================== HERO ============================== */}
      <section className="help-hero">
        <span className="eyebrow">Faculty Guide · A five-minute tour</span>
        <h1>
          Grade with confidence. Keep every decision <em>yours</em>.
        </h1>
        <p className="lede">
          BYU-(A)I Grader drafts rubric-aligned scores and feedback for every submission, then
          waits. You review each draft, edit anything, and approve what posts. Nothing reaches
          Canvas without your sign-off.
        </p>
        <div className="hero-points">
          <span>
            <i className="dot" /> AI drafts, you decide
          </span>
          <span>
            <i className="dot" /> Your data stays in Canvas
          </span>
          <span>
            <i className="dot" /> Close the browser, resume later
          </span>
        </div>
        <div className="hero-cta">
          <a className="primary" href="#launch">
            Start the tour ↓
          </a>
          <a className="ghost" href="#faq">
            Jump to common questions
          </a>
        </div>
      </section>

      {/* =========================== TRUST STRIP ========================== */}
      <div className="trust-strip">
        <div className="trust-card green">
          <span className="ico">✓</span>
          <div>
            <b>Nothing posts without you</b>
            <p>
              Every AI draft waits for your explicit approval. This safeguard is built in and
              cannot be turned off.
            </p>
          </div>
        </div>
        <div className="trust-card">
          <span className="ico">▤</span>
          <div>
            <b>Your data stays in your course</b>
            <p>
              Profiles, prep settings, and run history live in a hidden &quot;AI
              Grader&quot; folder in this course&apos;s Canvas files. No outside student-data
              stores.
            </p>
          </div>
        </div>
        <div className="trust-card">
          <span className="ico">✎</span>
          <div>
            <b>Signed and transparent</b>
            <p>
              Every posted comment begins with <b>{REVIEWED_PREFIX}</b> — your name in the
              brackets — so students know a human approved their grade.
            </p>
          </div>
        </div>
      </div>

      {/* ============================ THE TOUR ============================ */}
      <div className="tour">
        <nav className="rail" aria-label="Guide chapters">
          <p className="rail-title">The journey</p>
          <div className="rail-stops">
            <span className="rail-track" />
            {CHAPTERS.map(([id, stop, label]) => (
              <a key={id} href={`#${id}`}>
                <span className="stop">{stop}</span>
                {label}
              </a>
            ))}
          </div>
        </nav>

        <div className="chapters">
          {/* ---------------- 1 · LAUNCH ---------------- */}
          <section className="chapter" id="launch">
            <div className="ch-head">
              <span className="ch-num">01</span>
              <p className="ch-kicker">Chapter 1</p>
              <h2>Start from Codex</h2>
              <p className="promise">
                The grader runs on your own computer. You talk to Codex; Codex drives the grader
                and opens this review page when there is something to review.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>
                  No website to sign in to — the grader uses your own Canvas account, so every grade
                  posts under your name.
                </li>
                <li>
                  Everything you build here (profiles, settings, history) is stored in the course
                  itself, so it travels with course copies.
                </li>
              </ul>
            </div>
            <ol className="steps">
              <li>
                <b>One-time setup.</b> Ask Codex to <i>install the BYU-I AI Grader</i>. When it asks,
                paste your Canvas address and a Canvas <b>access token</b> (Canvas → Account →
                Settings → New Access Token) into the settings file it opens, then save.
              </li>
              <li>
                <b>Pick a course.</b> Ask Codex something like <i>&ldquo;Grade Essay 2 in my ENG 101
                course.&rdquo;</i> Codex finds the course and assignment and starts a grading run.
              </li>
              <li>
                <b>Review here.</b> When drafts are ready, Codex opens this review page in your
                browser. Only this page can approve and post grades — Codex cannot.
              </li>
            </ol>
            <Plate
              where="Codex · Chat"
              title="Starting a run"
              caption="Ask Codex in plain language; it prepares the assignment, starts the run, and opens this page for your review."
            />
          </section>

          {/* ---------------- 2 · DASHBOARD ---------------- */}
          <section className="chapter" id="dashboard">
            <div className="ch-head">
              <span className="ch-num">02</span>
              <p className="ch-kicker">Chapter 2</p>
              <h2>Get your bearings</h2>
              <p className="promise">
                The dashboard is one screen that tells you how healthy the course is and where to
                pick up.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>Course alignment health is visible at a glance, before grading ever starts.</li>
                <li>How many submissions are waiting to be graded is always in view.</li>
                <li>Every gradable assignment and every past grading run is one click away.</li>
              </ul>
            </div>
            <ol className="steps">
              <li>
                <b>Get Started in 3 Steps</b> walks the core flow: select an assignment, create
                your AI Profile, review and launch.
              </li>
              <li>
                <b>Course Pulse</b> shows how many submissions are waiting, plus how many
                assignments are ready to grade or still upcoming.
              </li>
              <li>
                <b>Course Alignment Overview</b> counts your learning outcomes and rubrics, scores
                overall alignment, and flags issues to review.
              </li>
              <li>
                <b>Assignments</b> previews your gradable items with a search box, and{' '}
                <b>Recent grading runs</b> reopens any past run exactly where you left it.
              </li>
            </ol>
            <Plate
              where="BYU-(A)I Grader · Dashboard"
              title="The dashboard"
              caption="Three-step guide, course pulse, alignment stat cards with the score donut, and recent runs."
            />
            <Plate
              where="BYU-(A)I Grader · Assignments"
              title="The Assignments page"
              caption="Gradable items grouped by grading stage: Ready to be graded (with how many submissions are waiting) at the top, Upcoming with nothing submitted yet, and Past already graded at the bottom. Each row shows type, points, rubric size, and due date."
            />
          </section>

          {/* ---------------- 3 · AI PROFILE ---------------- */}
          <section className="chapter" id="profile">
            <div className="ch-head">
              <span className="ch-num">03</span>
              <p className="ch-kicker">Chapter 3</p>
              <h2>Teach the AI how you grade</h2>
              <p className="promise">
                About ten minutes, once per course. After this, every draft is calibrated to{' '}
                <em>your</em> standards and voice.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>
                  Drafts reflect your philosophy, tone, and strictness instead of a generic
                  grader&apos;s.
                </li>
                <li>
                  The same calibration applies to the 1st and the 100th submission. Consistency
                  students can feel.
                </li>
                <li>
                  The profile is saved in the course, so a course copy carries your setup to next
                  semester.
                </li>
              </ul>
            </div>
            <p>
              Open <span className="ui">Course AI Profile</span> in the sidebar. The profile is a
              four-step wizard:
            </p>
            <ol className="steps">
              <li>
                <b>Course Context.</b> Course level, course type, and whether it fills a General
                Education requirement. Your linked Canvas outcomes are shown here too.
              </li>
              <li>
                <b>Grading Lens.</b> Describe what strong work looks like, your philosophy for
                judgment calls, a feedback tone, and a strictness slider from Forgiving to Very
                Strict.
              </li>
              <li>
                <b>AI &amp; Feedback Settings.</b> Feedback length, evidence expectations,
                missing-work penalties, your course&apos;s student AI policy, writing emphasis
                sliders, phrases in your voice, and a list of common mistakes to watch for.
              </li>
              <li>
                <b>Review &amp; Save.</b> Read the exact calibration text the AI will receive, then
                click <span className="ui">Save Profile</span>.
              </li>
            </ol>
            <Plate
              where="BYU-(A)I Grader · Course AI Profile"
              title="Profile wizard, step 4"
              caption="Review & Save shows the exact calibration text the AI will read. No hidden prompt, no surprises."
            />
            <div className="callout tip">
              <span className="c-ico">✦</span>
              <div>
                <b>Already built a profile elsewhere?</b> Enter that course&apos;s Canvas ID under{' '}
                <span className="ui">Import from another course</span> to copy it in. Outcomes stay
                behind, since they belong to the source course.
              </div>
            </div>
            <div className="callout safe">
              <span className="c-ico">✓</span>
              <div>
                <b>Always on:</b> every AI draft requires your review and approval before anything
                posts to Canvas. This cannot be disabled.
              </div>
            </div>
          </section>

          {/* ---------------- 4 · ALIGNMENT ---------------- */}
          <section className="chapter" id="alignment">
            <div className="ch-head">
              <span className="ch-num">04</span>
              <p className="ch-kicker">Chapter 4</p>
              <h2>Strengthen the foundations</h2>
              <p className="promise">
                Clear, outcome-linked rubrics produce fairer grades, better AI drafts, and fewer
                student disputes.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>Finds gaps between outcomes, rubrics, and instructions before students find them.</li>
                <li>Every finding comes with a severity and a concrete, prioritized suggestion.</li>
                <li>
                  Manage your course outcomes — browse the institution library, link, unlink, or
                  create — without leaving the tool.
                </li>
              </ul>
            </div>
            <p>
              Open <span className="ui">Outcomes &amp; Alignment</span> in the sidebar and click{' '}
              <span className="ui">Run Alignment Review</span>. The AI reads your outcomes,
              rubrics, and assignment instructions, then organizes what it finds into three tabs:
            </p>
            <ol className="steps">
              <li>
                <b>Alignment Audit</b> scores the course (a quick structural estimate appears even
                before your first review), lists each assignment&apos;s review status, groups
                findings by assignment, and turns them into a prioritized recommendation list.
                Past audits stay in the history table so you can watch the score improve.
              </li>
              <li>
                <b>Outcomes</b> lists your course outcomes live from Canvas, with{' '}
                <span className="ui">Browse Library</span> to link outcomes from your
                institution&apos;s library and <span className="ui">+ Create Outcome</span> to add
                new ones.
              </li>
              <li>
                <b>Rubrics</b> lets you edit any assignment&apos;s rubric right here — criteria,
                ratings, points, and outcome links — and saves it back to Canvas. Rubrics shared
                by several assignments warn you before you change them. Re-run the review
                afterwards to see the score move.
              </li>
            </ol>
            <Plate
              where="BYU-(A)I Grader · Outcomes & Alignment"
              title="Alignment overview"
              caption="Score donut, issue counts, and the review-top-down guide. Results persist between visits."
            />
            <div className="callout note">
              <span className="c-ico">!</span>
              <div>
                <b>Library not loading?</b> Browsing the institution&apos;s outcome library
                requires Canvas permissions your administrator controls. If you see &quot;Could not
                load the outcome library,&quot; contact your Canvas administrator, or write{' '}
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
              </div>
            </div>
          </section>

          {/* ---------------- 5 · PREPARE ---------------- */}
          <section className="chapter" id="prepare">
            <div className="ch-head">
              <span className="ch-num">05</span>
              <p className="ch-kicker">Chapter 5</p>
              <h2>Prepare the assignment</h2>
              <p className="promise">
                A few minutes of preparation buys noticeably better drafts on every run that
                follows.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>
                  Standing instructions are saved with the assignment and applied to every future
                  run.
                </li>
                <li>
                  Upload the starter template and the AI stops giving credit for unchanged
                  boilerplate.
                </li>
                <li>
                  An Excel answer key triggers a deterministic, cell-by-cell comparison instead of
                  guesswork.
                </li>
              </ul>
            </div>
            <p>
              From <span className="ui">Assignments</span>, open any item to prepare it:
            </p>
            <ol className="steps">
              <li>
                <b>Rubric.</b> Review the Canvas rubric and choose whether to share it with the AI.
                Items without a rubric are graded from the instructions alone.
              </li>
              <li>
                <b>Instructions.</b> Choose whether to share the assignment instructions, and write{' '}
                <b>standing grading instructions</b> for rules specific to this assignment, like
                &quot;full credit requires at least three sources.&quot; Save your prep settings.
              </li>
              <li>
                <b>Grading materials</b> (optional). Upload a student starter template and a
                grading key or model answer.
              </li>
              <li>
                <b>Start a grading run.</b> Add one-off notes for this run only, and include
                already-graded submissions if you want a full regrade.
              </li>
            </ol>
            <Plate
              where="BYU-(A)I Grader · Prepare"
              title="The prepare screen"
              caption="Rubric panel, standing instructions, grading materials, and the Start Grading Run button."
            />
          </section>

          {/* ---------------- 6 · RUN & REVIEW ---------------- */}
          <section className="chapter" id="run">
            <div className="ch-head">
              <span className="ch-num">06</span>
              <p className="ch-kicker">Chapter 6</p>
              <h2>Run the AI, then review every draft</h2>
              <p className="promise">
                The first pass over a whole class takes minutes. The judgment stays with you.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>
                  Drafts appear live as the AI works. A whole section is typically drafted in
                  minutes.
                </li>
                <li>Every student gets the same rubric lens. No end-of-stack fatigue, no drift.</li>
                <li>Every number and every comment is editable. The AI proposes, you dispose.</li>
              </ul>
            </div>
            <ol className="steps">
              <li>
                Click <span className="ui">Start Grading Run</span>. Each student&apos;s status
                updates live, from <i>AI grading…</i> to <i>Draft ready</i>, with a progress bar
                across the top.
              </li>
              <li>
                Open any student to review:
                <ul>
                  <li>
                    <b>Submission view</b> shows what the student actually turned in, rendered
                    right in the app: Word documents, spreadsheets as tabbed sheets with a
                    formulas view, code with syntax highlighting, and images you can zoom. Older
                    formats (.doc, .rtf) show a converted preview, and a download link always
                    fetches the original. When a student submitted several files, tabs above the
                    preview switch between them.
                  </li>
                  <li>
                    <b>Per-criterion scores and comments</b> are all editable. Editing flips the
                    badge to <i>Edited</i>.
                  </li>
                  <li>
                    <b>Overall feedback</b> is the comment that will post, previewed exactly as
                    students will see it: <i>{REVIEWED_PREFIX} …</i>
                  </li>
                </ul>
              </li>
            </ol>
            <Plate
              where="BYU-(A)I Grader · Grading run"
              title="A run in progress"
              caption="Per-student status updates live while the AI drafts, with a progress bar across the run."
            />
            <Plate
              where="BYU-(A)I Grader · Review"
              title="The review screen"
              caption="Submission view on the left; editable criterion scores, comments, and overall feedback on the right."
            />
            <div className="callout safe">
              <span className="c-ico">✓</span>
              <div>
                <b>The total is always the criterion sum.</b> Edit any criterion score and the
                total recalculates instantly. What you see in that box is exactly what posts to
                Canvas, down to the decimal.
              </div>
            </div>
          </section>

          {/* ---------------- 7 · APPROVE & POST ---------------- */}
          <section className="chapter" id="post">
            <div className="ch-head">
              <span className="ch-num">07</span>
              <p className="ch-kicker">Chapter 7</p>
              <h2>Approve and post to Canvas</h2>
              <p className="promise">
                One click writes the grade, the full rubric assessment, and your signed comment. No
                copying into SpeedGrader.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>
                  Grade, rubric ratings, per-criterion comments, and overall feedback land
                  together, in one step.
                </li>
                <li>
                  Approved grades are never double-posted, even if you close the browser mid-run
                  and come back.
                </li>
                <li>
                  The <b>{REVIEWED_PREFIX}</b> signature keeps the process transparent to students.
                </li>
              </ul>
            </div>
            <ol className="steps">
              <li>
                <span className="ui">Approve &amp; post to Canvas</span> posts the current student
                and advances to the next. Their badge turns <i>Posted</i> with a timestamp.
              </li>
              <li>
                <span className="ui">Approve all drafts</span> bulk-posts every remaining reviewed
                draft.
              </li>
              <li>
                <span className="ui">Next student</span> moves on without posting anything.
              </li>
            </ol>
            <p>What lands in Canvas for each approved student:</p>
            <ol className="steps">
              <li>
                The assignment <b>grade</b> — the sum of your approved criterion scores.
              </li>
              <li>
                The full <b>rubric assessment</b> — the selected rating and comment on every
                criterion.
              </li>
              <li>
                A <b>submission comment</b> beginning with <b>{REVIEWED_PREFIX}</b>, followed by
                the overall feedback you approved.
              </li>
            </ol>
            <Plate
              where="BYU-(A)I Grader · Run complete"
              title="After approval"
              caption="The run shows COMPLETED and every student carries a green Posted badge with a timestamp."
            />
            <Plate
              where="Canvas · SpeedGrader"
              title="Verified in Canvas"
              caption="SpeedGrader after posting: the grade, rubric assessment, and signed comment match the review screen exactly."
            />
            <div className="callout tip">
              <span className="c-ico">✦</span>
              <div>
                <b>Run came up empty?</b> Runs draft ungraded submissions by default. If everyone
                is already graded, start the run with already-graded submissions included.
              </div>
            </div>
          </section>

          {/* ---------------- 8 · RESUME ---------------- */}
          <section className="chapter" id="resume">
            <div className="ch-head">
              <span className="ch-num">08</span>
              <p className="ch-kicker">Chapter 8</p>
              <h2>Walk away anytime</h2>
              <p className="promise">
                Grade in the twenty-minute pockets of a real week. The run will be exactly where
                you left it.
              </p>
            </div>
            <div className="benefit">
              <p className="b-title">✦ Why this matters</p>
              <ul>
                <li>Every run is continuously checkpointed to your course&apos;s Canvas storage.</li>
                <li>Close the laptop mid-review; drafts, edits, and posted statuses all survive.</li>
                <li>Reopening never re-posts anything that already posted.</li>
              </ul>
            </div>
            <p>
              Find any past run under <b>Recent grading runs</b> on the Dashboard or the{' '}
              <span className="ui">Grading Runs</span> page and click <span className="ui">Open</span>.
              The full state comes back: AI drafts, your edits, and each student&apos;s Posted
              status. If a student resubmitted after you graded, the run flags them so you can take
              another look.
            </p>
          </section>

          {/* ---------------- 9 · WHAT'S GRADABLE ---------------- */}
          <section className="chapter" id="types">
            <div className="ch-head">
              <span className="ch-num">09</span>
              <p className="ch-kicker">Chapter 9</p>
              <h2>What can be graded</h2>
              <p className="promise">
                Most of your gradebook, including work students photograph and upload.
              </p>
            </div>
            <div className="types-grid">
              <div className="type-card">
                <div className="t-head">
                  <b>Essays &amp; text entry</b>
                  <span className="type-pill ok">Supported</span>
                </div>
                <p>The core flow: rubric-aligned drafting, review, and posting, end to end.</p>
              </div>
              <div className="type-card">
                <div className="t-head">
                  <b>File uploads &amp; URLs</b>
                  <span className="type-pill ok">Supported</span>
                </div>
                <p>
                  Documents and spreadsheets are read and graded. Spreadsheet grading sees what
                  Excel-skills rubrics grade: cell formatting (fills, bold, font and size,
                  alignment), column widths, freeze panes, merged cells, worksheet names, and
                  formulas — including whether a formula was filled down a range. Image files (JPG,
                  PNG, GIF, WebP) are graded visually, so photographed handwritten work counts too.
                  When a student turns in several files, all of them are read and graded together.
                </p>
              </div>
              <div className="type-card">
                <div className="t-head">
                  <b>Graded discussions</b>
                  <span className="type-pill ok">Supported</span>
                </div>
                <p>
                  Each student&apos;s posts and replies are gathered into one document and graded
                  against your instructions.
                </p>
              </div>
              <div className="type-card">
                <div className="t-head">
                  <b>Classic quizzes</b>
                  <span className="type-pill ok">Essay questions</span>
                </div>
                <p>
                  Essay questions are drafted question by question across all students, so you
                  calibrate one question at a time. Canvas keeps auto-grading the rest.
                </p>
              </div>
            </div>
            <Plate
              where="BYU-(A)I Grader · Quiz review"
              title="Quiz review layout"
              caption="Quiz drafts are grouped by question: read every answer to Question 1 together, then move on."
            />
            <div className="callout note">
              <span className="c-ico">!</span>
              <div>
                <b>Scanned PDFs:</b> a PDF that is just a photograph of pages (no selectable text)
                cannot be read and will show a clear &quot;appears scanned&quot; message. Ask
                students to upload the original file or images instead.
              </div>
            </div>
          </section>

          {/* ---------------- FAQ ---------------- */}
          <section className="chapter" id="faq">
            <div className="ch-head">
              <span className="ch-num">?</span>
              <p className="ch-kicker">Quick answers</p>
              <h2>Common questions</h2>
            </div>
            <div className="faq">
              <details>
                <summary>Does anything post to Canvas without me?</summary>
                <p>
                  No. Drafts stay inside the tool until you click an approve button, and every
                  posted comment carries the <b>{REVIEWED_PREFIX}</b> prefix. There is no setting
                  that changes this.
                </p>
              </details>
              <details>
                <summary>Where is my data stored?</summary>
                <p>
                  In a hidden, locked &quot;AI Grader&quot; folder inside this course&apos;s
                  Canvas files: your profile, prep settings, alignment results, and run history.
                  Copying the course brings your profile along. Student work is never stored on
                  your computer; your Canvas token stays in a private settings file that only your
                  account can read.
                </p>
              </details>
              <details>
                <summary>Can students tell the AI was involved?</summary>
                <p>
                  Yes, by design. Every comment is signed <b>{REVIEWED_PREFIX}</b>, which tells
                  students a human reviewed and approved the grade. Transparency is part of the
                  tool&apos;s policy, not an option.
                </p>
              </details>
              <details>
                <summary>How do I make the AI stricter, kinder, or more like me?</summary>
                <p>
                  Adjust the Strictness, Evidence-expectation, and Missing-work-penalty sliders in
                  your Course AI Profile, add phrases in your voice, and use standing grading
                  instructions on each assignment for assignment-specific rules. The Review &amp;
                  Save step always shows the exact text the AI reads.
                </p>
              </details>
              <details>
                <summary>This page says my review session ended.</summary>
                <p>
                  Ask Codex to open the review page again (or run <b>aigrader open</b>). For your
                  security, the page only opens through a fresh one-time link.
                </p>
              </details>
              <details>
                <summary>What if a student resubmits after I&apos;ve graded them?</summary>
                <p>
                  When you reopen a run, students whose submission changed after their draft was
                  graded are flagged with a &quot;resubmitted&quot; notice so you can re-run just
                  them.
                </p>
              </details>
              <details>
                <summary>Who do I contact for help?</summary>
                <p>
                  Write <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> (BYU-Idaho
                  Instructional Technology). Canvas permissions and course access are managed by
                  BYU-Idaho&apos;s Canvas administrators.
                </p>
              </details>
            </div>
          </section>
        </div>
      </div>

      {/* ============================== FOOTER ============================ */}
      <footer className="help-footer">
        <div>
          <b>Still have a question?</b>
          <p>
            Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. This guide is always
            here under Help &amp; Resources.
          </p>
        </div>
        <a className="back-top" href="#top">
          Back to top ↑
        </a>
      </footer>
    </div>
  );
}
