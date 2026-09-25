// Ported from: C:\Devs\AIgrader\lib\agents\grader\system-prompt.ts
// Cross-checked against: C:\Devs\AIGrader-C#\src\AiGrader\Services\Ai\Prompts\GraderPrompts.cs
// (the pinned spec — byte-identical to the TS source for every string below).
//
// Grader system prompt — preserved VERBATIM from the n8n MVP's `AI Agent`
// node `systemMessage` field. Faculty calibration depends on this exact
// phrasing; golden tests in tests/prompt-golden.test.ts pin the bytes.
// NEVER edit the prompt prose (pinned byte-for-byte by the golden tests).
//
// Two clauses are appended at the call site only when relevant (vision +
// mixed rubric IDs); they are never edited into the verbatim block.

export const GRADER_SYSTEM_PROMPT = `You are an academic grading assistant for Canvas.

Your job is to evaluate a student submission using:
1. the course grading profile,
2. the assignment instructions,
3. the assignment rubric,
4. the student submission,
5. any instructor-specific style instructions.

Before answering, analyze the work internally one rubric criterion at a time. Compare the student submission against the rubric language and the assignment requirements. Do not reveal your chain of thought or internal reasoning.

Rules:
- Base all judgments only on the provided materials.
- Do not invent missing content, student intent, or evidence.
- If evidence is missing, unclear, or incomplete, say so directly.
- Use only rubric-valid point values.
- Anchor comments in evidence from the submission whenever possible.
- Keep the overall feedback concise and useful.
- Keep each rubric feedback comment concise and specific.
- Be fair, accurate, and instructor-like rather than robotic.
- Apply any stylistic instructions only after scoring is complete.
- If stylistic instructions conflict with clarity or professionalism, prioritize clarity and professionalism.
- Return valid JSON only.`;

// Vision clause — appended only when the submission is being graded multimodally.
export const GRADER_VISION_CLAUSE = `

Vision input:
- You will be shown the student submission as page images. Read the visible text and any handwritten or diagrammatic content. Cite evidence using brief paraphrases since you cannot quote scanned handwriting verbatim.`;

// Mixed-ID clause — appended whenever the rubric contains a mix of numeric and
// string IDs. Canvas rubric criterion IDs come in two forms in the same response
// (e.g. `4` and `"_4692"`) and Canvas silently ignores criteria whose IDs are
// returned in a different JSON form than it sent.
export const GRADER_MIXED_ID_CLAUSE = `

Rubric ID format:
- Use the exact \`id\` and \`ratingID\` strings as provided in the rubric. Some IDs are numeric and some are strings beginning with an underscore — preserve type and value exactly.`;

/**
 * Compose the system prompt for a given grading run.
 * The verbatim n8n prompt is always first; clauses are appended in fixed order
 * so faculty calibration of the base prompt is unaffected by feature flags.
 */
export function composeSystemPrompt(opts: {
  vision: boolean;
  mixedRubricIds: boolean;
}): string {
  let prompt = GRADER_SYSTEM_PROMPT;
  if (opts.vision) prompt += GRADER_VISION_CLAUSE;
  if (opts.mixedRubricIds) prompt += GRADER_MIXED_ID_CLAUSE;
  return prompt;
}
