// Ported from: C:\Devs\AIgrader\lib\agents\grader\quiz-prompt.ts
// Cross-checked against: C:\Devs\AIGrader-C#\src\AiGrader\Services\Ai\Prompts\QuizPrompts.cs
// (the pinned spec — byte-identical to the TS source for every string below).
//
// Quiz per-question grading prompt.
//
// This prompt module is deliberately kept separate from the verbatim n8n
// assignment prompts (system-prompt.ts / user-template.ts), which must not be
// altered. The assignment path grades a whole submission against a rubric
// array; the quiz path grades one short essay answer against one question's
// prompt + point value + any author-provided sample comments.
//
// The two prompts intentionally share tone and grounding rules (grade only on
// provided materials, anchor in evidence, no invented content) so faculty
// calibration carries over, but the quiz prompt's structured output is the
// per-question { score, comment } shape (see ../../llm/response-schemas.ts),
// not the rubric-array GraderOutput.

import { stripHtml } from './strip-html.js';

export const QUIZ_QUESTION_SYSTEM_PROMPT = `You are an academic grading assistant for Canvas quiz questions.

Your job is to grade ONE student's answer to ONE quiz question using:
1. the course grading profile,
2. the question prompt,
3. the question's point value,
4. any author-provided grading guidance for the question,
5. the student's answer,
6. any instructor-specific style instructions.

Before answering, analyze the answer internally against the question prompt and the maximum point value. Do not reveal your chain of thought or internal reasoning.

Rules:
- Base all judgments only on the provided materials.
- Do not invent missing content, student intent, or evidence.
- If the answer is missing, unclear, or incomplete, say so directly and score accordingly.
- The score must be between 0 and the question's maximum point value, inclusive.
- Anchor your comment in evidence from the student's answer whenever possible.
- Keep the comment concise, specific, and useful to the student.
- Be fair, accurate, and instructor-like rather than robotic.
- Apply any stylistic instructions only after scoring is complete.
- If stylistic instructions conflict with clarity or professionalism, prioritize clarity and professionalism.
- Return valid JSON only.`;

export type BuildQuizQuestionMessageArgs = {
  courseProfileText: string;
  questionName: string;
  // Raw HTML from Canvas; this builder strips it.
  questionTextHtml: string;
  maxPoints: number;
  // Author-provided per-question guidance (correct_comments / neutral_comments
  // from the Canvas question). Either may be empty.
  correctComments?: string | null;
  neutralComments?: string | null;
  // The student's full answer text for this question.
  studentAnswerText: string;
  // Merged faculty instructions (assignment-level + the run's additional
  // instructions), same source the assignment path uses.
  additionalInstructions?: string | null;
};

export function buildQuizQuestionUserMessage(args: BuildQuizQuestionMessageArgs): string {
  const questionPrompt = stripHtml(args.questionTextHtml ?? '').trim();
  const guidance = buildGuidanceBlock(args.correctComments, args.neutralComments);

  // Section headers are always present so the layout is stable across
  // questions, mirroring the assignment template's fixed-header approach.
  return `Grade this single quiz question answer.

COURSE GRADING PROFILE
${args.courseProfileText ?? ''}

QUESTION NAME
${args.questionName ?? ''}

QUESTION PROMPT
${questionPrompt}

MAXIMUM POINTS
${args.maxPoints}

GRADING GUIDANCE
${guidance}

STUDENT ANSWER
${args.studentAnswerText ?? ''}

INSTRUCTOR STYLE NOTES
${args.additionalInstructions ?? ''}

Scoring instructions:
1. Read the question prompt and the maximum point value.
2. Evaluate the student's answer against the prompt and any grading guidance.
3. Assign a score between 0 and the maximum points (inclusive).
4. Write a concise comment explaining the score and citing brief evidence from the answer.
`;
}

// Fold the question's author-provided comment fields into one guidance block.
// When both are empty the header still renders (empty), keeping the layout
// stable — the model is instructed to fall back to the prompt + point value.
function buildGuidanceBlock(
  correctComments?: string | null,
  neutralComments?: string | null,
): string {
  const parts: string[] = [];
  const correct = correctComments?.trim();
  const neutral = neutralComments?.trim();
  if (correct) parts.push(`What a correct answer looks like: ${correct}`);
  if (neutral) parts.push(`General notes: ${neutral}`);
  return parts.join('\n');
}
