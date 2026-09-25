# BYU-(A)I Grader for Codex

AI-assisted, rubric-aligned grading for BYU-Idaho Canvas courses. It runs on
your own Mac or Windows computer and is driven by OpenAI Codex, using the Codex
access BYU-Idaho provides to faculty.

- **The AI drafts, you decide.** Each submission is drafted in its own private
  Codex session. You review every draft in a local review page, edit anything,
  and approve what posts. Nothing reaches Canvas without your click.
- **Your Canvas account.** The grader uses your own Canvas access token, stored
  in a private settings file on your computer, so grades post under your name.
  Every posted comment begins with `[As Reviewed by <your name>]`.
- **Your data stays in Canvas.** Profiles, prep settings, and grading history
  live in a hidden, locked "AI Grader" folder inside each course, the same
  folder the earlier BYU-(A)I Grader used.
- **Graded by your own Codex.** Each student is graded by a private, tool-less
  Codex session signed in as you. Grading pauses on its own at 85% of a Codex
  usage window (so you keep room for chat) and resumes when the window resets.

## Getting started (faculty)

Ask Codex: **"Install the BYU-I AI Grader."** Codex runs the installer, which
puts the grader in your user folder (no admin rights needed). When prompted,
add your Canvas address and access token to `~/.aigrader/.env`:

```dotenv
CANVAS_BASE_URL=https://byui.instructure.com
CANVAS_API_TOKEN=<Canvas → Account → Settings → + New Access Token>
```

Then start a new Codex session and ask, for example, *"Grade Essay 2 in my
ENG 101 course."*

## Development

```powershell
corepack enable                  # once: puts pnpm 10 on PATH
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build                   # packages, the review UI (.next), the CLI
```

Run the local server from a checkout (after `build`):

```powershell
node apps/aigrader/bin/aigrader.mjs serve --detach   # start in the background
node apps/aigrader/bin/aigrader.mjs open             # review page (browser)
node apps/aigrader/bin/aigrader.mjs status
node apps/aigrader/bin/aigrader.mjs stop
```

Set `AIGRADER_HOME` to use a scratch profile instead of `~/.aigrader`
(`.env.example` shows every setting).

Ground rules for contributors (human or AI):

- **Nothing posts without a click in the review page.** Only the browser-guarded
  approve route can reach the engine's approve; no CLI command or Codex tool can.
- **Student data stays in Canvas**, in the course's hidden "AI Grader" folder,
  in the same JSON formats the C# app used (new state = optional fields only).
- **The Canvas token lives only in `~/.aigrader/.env`** and is never logged,
  echoed, or returned.
- **Prompt text is byte-pinned** by golden tests; `.gitattributes` keeps LF.
- **No native modules** in the shipped bundle (it runs on any platform's Node 24).

## Provenance

A TypeScript rewrite of the C# BYU-(A)I Grader. `// Ported from: …` comments
throughout point back to the original implementations.
