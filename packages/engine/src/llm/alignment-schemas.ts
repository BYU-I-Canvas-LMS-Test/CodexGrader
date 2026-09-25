// Ported from: C:\Devs\AIgrader\lib\agents\alignment\schema.ts (zod gate)
// Cross-checked against: C:\Devs\AIGrader-C#\src\AiGrader\Services\Alignment\
//   AlignmentReviewAgent.cs (ReportSchema — where the two differ, C# wins:
//   the C# review dropped the TS criterionOutcomeMatches block, so the result
//   shape is { alignmentScore, summary, findings } only).
//
// Two sides of the alignment-review contract, mirroring response-schemas.ts:
//  1. Zod schemas — the VALIDATION gate on what the model actually returned.
//  2. A strict JSON Schema builder — the model's required output schema,
//     with severity and pairing pinned to their exact enums so the model
//     cannot emit a wrong-form value.
//
// Alignment reviews reason over instructor-authored artifacts ONLY (outcomes,
// rubrics, instructions) — no student data enters this path.

import { z } from 'zod';
import type { JsonSchema } from './json-schema.js';

// ------------------------------------------------------------- zod (gate) --

export const AlignmentSeveritySchema = z.enum(['high', 'medium', 'low']);

// The model sometimes returns a level as an object like { level: 'high',
// note: '…' } instead of a bare string. Accept either so a good review isn't
// rejected over shape drift. (Lifted from the TS schema's LenientLevel.)
const LenientLevel = z.preprocess((v) => {
  if (v && typeof v === 'object' && 'level' in v) {
    return (v as { level: unknown }).level;
  }
  return v;
}, AlignmentSeveritySchema);

// Which pair of artifacts a finding concerns.
export const AlignmentPairingSchema = z.enum([
  'rubric_outcome', // a rubric criterion vs the learning outcome it should measure
  'rubric_instructions', // a rubric criterion vs the assignment instructions
  'outcome_instructions', // a learning outcome vs the assignment instructions
]);

export const AlignmentFindingSchema = z.object({
  severity: LenientLevel,
  pairing: AlignmentPairingSchema,
  title: z.string().min(1), // short headline
  detail: z.string().min(1), // 1-3 sentences explaining the misalignment
  suggestion: z.string().min(1), // a concrete fix the instructor can act on
});

export const AssignmentAlignmentSchema = z.object({
  // 0-100 coherence score across the three artifacts.
  alignmentScore: z.number().min(0).max(100),
  summary: z.string().min(1),
  findings: z.array(AlignmentFindingSchema),
});

export type AlignmentSeverity = z.infer<typeof AlignmentSeveritySchema>;
export type AlignmentPairing = z.infer<typeof AlignmentPairingSchema>;
export type AlignmentFindingOutput = z.infer<typeof AlignmentFindingSchema>;
export type AssignmentAlignment = z.infer<typeof AssignmentAlignmentSchema>;

// ------------------------------------------- strict output schema (guard) --

/**
 * The (static) strict output schema for one assignment's alignment review.
 * Field names and descriptions mirror the C# ReportSchema (the pinned spec);
 * severity/pairing are string with the exact enum values.
 */
export function buildAlignmentResponseSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      alignmentScore: {
        type: 'number',
        description: '0-100 overall coherence score.',
      },
      summary: {
        type: 'string',
        description: 'One-paragraph overall assessment.',
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            pairing: {
              type: 'string',
              enum: ['rubric_outcome', 'rubric_instructions', 'outcome_instructions'],
            },
            title: { type: 'string' },
            detail: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['severity', 'pairing', 'title', 'detail', 'suggestion'],
          additionalProperties: false,
        },
      },
    },
    required: ['alignmentScore', 'summary', 'findings'],
    additionalProperties: false,
  };
}
