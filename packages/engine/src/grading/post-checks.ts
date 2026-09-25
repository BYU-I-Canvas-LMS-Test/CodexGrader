// Post-grading checks: things a reviewer should look at before approving,
// raised as amber warnings on the review card (the row's extractionWarnings
// list — an existing field, so no storage change). They never change a
// score or block anything; they point the human at what to double-check:
//
//   - the feedback repeats the grading key (answers leaking to the student)
//   - the feedback contains a file path or something secret-looking
//   - the submission contains instructions aimed at the AI grader
//   - the submission contains hidden (zero-width / bidirectional) characters
//   - full marks with no evidence quoted from the submission

export interface PostCheckInput {
  submissionText: string;
  gradingKeyText: string | null;
  /** Overall feedback + every per-criterion comment. */
  feedbackTexts: readonly string[];
  score: number | null;
  pointsPossible: number | null;
}

export const WARN_KEY_LEAK =
  'The AI feedback repeats wording from your grading key — make sure it does not give away answers before you post it.';
export const WARN_PATH_OR_SECRET =
  'The AI feedback contains a file path or something that looks like a password or key — remove it before posting.';
export const WARN_INJECTION =
  'This submission contains text that looks like instructions to the AI grader — review the score carefully.';
export const WARN_HIDDEN_TEXT =
  'This submission contains hidden characters (zero-width or text-direction marks) that can hide words from a reader — review it carefully.';
export const WARN_UNSUPPORTED_FULL_MARKS =
  'Full marks, but the feedback quotes nothing from the submission — confirm the work earns it.';

/** Consecutive words shared with the key that count as "repeating" it. */
const KEY_RUN_WORDS = 8;
/** Consecutive words shared with the submission that count as a quote. */
const QUOTE_RUN_WORDS = 5;

const PATH_OR_SECRET = [
  /\b[A-Za-z]:\\[^\s]+/, // C:\Users\…
  /(?:^|[\s("'])\/(?:Users|home|var|tmp|private|etc)\/[^\s]+/,
  /\\\\[A-Za-z0-9._-]+\\/, // \\server\share
  /\b\d{3,6}~[A-Za-z0-9]{30,}\b/, // Canvas access token
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\baigrader-[A-Za-z0-9]{6}\b|\bsystem\.md\b|\banswer\.json\b/, // worker internals
];

const INJECTION = [
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|the)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rubric|rules)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|a\.i\.|language model|assistant|grader|chatgpt|codex)\b/i,
  /\b(?:give|award|assign)\b[^.\n]{0,30}\b(?:full|perfect|maximum|max|100\s*%?|all(?: the)?)\s+(?:marks?|points?|credit|score)\b/i,
  /\b(?:grade|score|mark)\s+(?:this|me|it)\s+(?:as\s+)?(?:an?\s+)?(?:a\+?|100|perfect|full)\b/i,
  /\bnote\s+to\s+(?:the\s+)?(?:ai|grader|model|assistant)\b/i,
];

const HIDDEN = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;

/** The score in a "score/total" string ("18/20" → 18); null when unreadable. */
export function scoreFromTotal(totalPoints: string): number | null {
  const head = totalPoints.split('/')[0] ?? '';
  const n = Number.parseFloat(head);
  return Number.isFinite(n) ? n : null;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function runs(tokens: readonly string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}

function sharesRun(a: readonly string[], b: Set<string>, n: number, exclude?: Set<string>): boolean {
  for (let i = 0; i + n <= a.length; i++) {
    const run = a.slice(i, i + n).join(' ');
    if (b.has(run) && !exclude?.has(run)) return true;
  }
  return false;
}

export function postGradeWarnings(input: PostCheckInput): string[] {
  const warnings: string[] = [];
  const feedback = input.feedbackTexts.filter(Boolean).join('\n');
  const feedbackWords = words(feedback);
  const submissionWords = words(input.submissionText);
  const submissionRuns = runs(submissionWords, KEY_RUN_WORDS);

  if (input.gradingKeyText) {
    const keyRuns = runs(words(input.gradingKeyText), KEY_RUN_WORDS);
    // Quoting the STUDENT's own words is fine even if the key says the same.
    if (keyRuns.size > 0 && sharesRun(feedbackWords, keyRuns, KEY_RUN_WORDS, submissionRuns)) {
      warnings.push(WARN_KEY_LEAK);
    }
  }

  if (PATH_OR_SECRET.some((re) => re.test(feedback))) warnings.push(WARN_PATH_OR_SECRET);

  if (INJECTION.some((re) => re.test(input.submissionText))) warnings.push(WARN_INJECTION);

  if ((input.submissionText.match(HIDDEN) ?? []).length >= 3) warnings.push(WARN_HIDDEN_TEXT);

  if (
    input.score !== null &&
    input.pointsPossible !== null &&
    input.pointsPossible > 0 &&
    input.score >= input.pointsPossible &&
    submissionWords.length >= 40 && // a one-line answer has little to quote
    !sharesRun(feedbackWords, runs(submissionWords, QUOTE_RUN_WORDS), QUOTE_RUN_WORDS)
  ) {
    warnings.push(WARN_UNSUPPORTED_FULL_MARKS);
  }
  return warnings;
}
