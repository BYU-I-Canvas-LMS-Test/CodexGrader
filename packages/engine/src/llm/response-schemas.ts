// Ported from: C:\Devs\AIgrader\lib\agents\grader\output-schema.ts
//          and C:\Devs\AIgrader\lib\agents\grader\quiz-output-schema.ts
// Cross-checked against: C:\Devs\AIGrader-C#\src\AiGrader\Models\Grading\GraderOutput.cs
//   (NumberOrStringJsonConverter id handling) and
//   C:\Devs\AIGrader-C#\src\AiGrader\Services\Ai\OpenAiGraderClient.cs
//   (GradeSubmissionSchema / GradeQuizQuestionSchema descriptions).
//
// Two sides of the same contract:
//  1. Zod schemas — the VALIDATION gate on what the model actually returned.
//     JSON keys are byte-identical to the n8n/TS originals (TotalPoints,
//     assignmentFeedback, Rubrics, id, ratingID, points, ratingFeedback,
//     score, comment) because the verbatim prompts reference these exact
//     names. Ids are normalized to their RAW STRING form (exact digits
//     preserved) mirroring the C# NumberOrStringJsonConverter — raw strings
//     end-to-end, no unions downstream.
//  2. Strict JSON Schema builders — handed to the model as its required
//     output schema (codex exec --output-schema), with criterion/rating ids
//     declared as string with an `enum` of the EXACT raw ids from the rubric
//     snapshot. Canvas silently drops criteria whose ids come back in a
//     different form than it sent, so the model must be UNABLE to emit a
//     wrong-form id (the silent-drop guard). Strict = every object sets
//     additionalProperties:false and lists every property as required.

import { z } from 'zod';
import type { JsonSchema } from './json-schema.js';

// ------------------------------------------------------------- zod (gate) --

// Mixed rubric ID format: Canvas returns criterion IDs as either numeric
// (e.g. 1745118159974, 4) or string with leading underscore (e.g. "_4692").
// The output schema pins them to strings, but models occasionally emit raw
// numbers — accept both and preserve the exact digits as a string (C#
// NumberOrStringJsonConverter behavior; JSON numeric ids are integers well
// under 2^53, so String() is digit-exact).
const RubricIdSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v));

export const RubricItemSchema = z.object({
  id: RubricIdSchema,
  ratingID: RubricIdSchema,
  points: z.number().nonnegative(),
  ratingFeedback: z.string().min(1),
});

export const GraderOutputSchema = z.object({
  TotalPoints: z
    .string()
    .regex(/^\d+(\.\d+)?\/\d+(\.\d+)?$/, 'Expected "score/total" format'),
  assignmentFeedback: z.string().min(1),
  Rubrics: z.array(RubricItemSchema),
});

export type RubricItem = z.infer<typeof RubricItemSchema>;
export type GraderOutput = z.infer<typeof GraderOutputSchema>;

// Per-question structured output for the Classic Quiz grading path. The unit
// of grading for a quiz is the QUESTION, not the submission: a single numeric
// score bounded by the question's point value plus a feedback comment.
export const QuizQuestionGraderOutputSchema = z.object({
  // Points awarded for this single question. Non-negative; the upper bound is
  // the question's points_possible and is clamped in the engine because the
  // ceiling varies per question and cannot be baked into a static schema.
  score: z.number().nonnegative(),
  // Feedback shown to the student for this question. The AI-indicator prefix
  // is added at writeback time, never here.
  comment: z.string().min(1),
});

export type QuizQuestionGraderOutput = z.infer<typeof QuizQuestionGraderOutputSchema>;

/**
 * Defensive clamp of a quiz score to [0, maxPoints]. The prompt states the
 * bound and the schema enforces non-negativity, but the per-question ceiling
 * cannot be expressed in a static schema — the clamp is the guarantee.
 */
export function clampQuizScore(score: number, maxPoints: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(Math.max(score, 0), maxPoints);
}

// ------------------------------------------- strict output schema (guard) --

/** One rubric-snapshot criterion's ids, EXACTLY as Canvas sent them (raw strings). */
export type ResponseSchemaCriterion = {
  id: string;
  ratingIds: string[];
};

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Builds the per-run strict output schema for assignment grading. `id` and
 * `ratingID` are string with an enum of the exact raw rubric-snapshot ids
 * ("_4692", "4", "1745118159974"…), so a wrong-form id cannot be emitted.
 * Descriptions mirror the C# GradeSubmissionSchema (the pinned spec).
 */
export function buildGradeSubmissionResponseSchema(
  criteria: readonly ResponseSchemaCriterion[],
): JsonSchema {
  const idEnum = dedupe(criteria.map((c) => c.id));
  const ratingIdEnum = dedupe(criteria.flatMap((c) => c.ratingIds));

  return {
    type: 'object',
    properties: {
      TotalPoints: {
        type: 'string',
        description: 'Total score as "score/total", e.g. "18/20".',
      },
      assignmentFeedback: {
        type: 'string',
        description: 'Concise overall feedback summary for the student.',
      },
      Rubrics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The criterion id EXACTLY as given in the rubric.',
              // A rubric always carries criterion ids; guard the degenerate
              // no-rubric case (enum: [] would forbid every value).
              ...(idEnum.length > 0 ? { enum: idEnum } : {}),
            },
            ratingID: {
              type: 'string',
              description: 'The chosen rating id EXACTLY as given in the rubric.',
              ...(ratingIdEnum.length > 0 ? { enum: ratingIdEnum } : {}),
            },
            points: {
              type: 'number',
              description: 'Points awarded for this criterion (rubric-valid values only).',
            },
            ratingFeedback: {
              type: 'string',
              description: 'Concise, evidence-anchored feedback for this criterion.',
            },
          },
          required: ['id', 'ratingID', 'points', 'ratingFeedback'],
          additionalProperties: false,
        },
      },
    },
    required: ['TotalPoints', 'assignmentFeedback', 'Rubrics'],
    additionalProperties: false,
  };
}

/**
 * The (static) strict output schema for quiz per-question grading.
 * Descriptions mirror the C# GradeQuizQuestionSchema.
 */
export function buildQuizQuestionResponseSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      score: {
        type: 'number',
        description: "Points awarded, between 0 and the question's maximum (inclusive).",
      },
      comment: {
        type: 'string',
        description: 'Concise, evidence-anchored feedback comment for the student.',
      },
    },
    required: ['score', 'comment'],
    additionalProperties: false,
  };
}
