// The two sides of the structured-output contract: the strict JSON Schema
// builders (raw rubric ids pinned via string enums — the silent-drop guard)
// and the ported zod validation gate (JSON keys byte-identical to the
// n8n/TS originals; ids normalized to raw strings like the C#
// NumberOrStringJsonConverter).

import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../src/llm/json-schema.js';
import { buildAlignmentResponseSchema } from '../src/llm/alignment-schemas.js';
import {
  GraderOutputSchema,
  QuizQuestionGraderOutputSchema,
  RubricItemSchema,
  buildGradeSubmissionResponseSchema,
  buildQuizQuestionResponseSchema,
  clampQuizScore,
} from '../src/llm/response-schemas.js';

const criteria = [
  { id: '_4692', ratingIds: ['_817', '_818'] },
  { id: '4', ratingIds: ['blank', 'blank_2'] },
  { id: '1745118159974', ratingIds: ['_817'] }, // '_817' repeats across criteria
];

describe('buildGradeSubmissionResponseSchema', () => {
  it('pins criterion ids as a string enum of the EXACT raw rubric ids', () => {
    const schema = buildGradeSubmissionResponseSchema(criteria);
    const item = schema.properties!.Rubrics!.items!;
    const id = item.properties!.id!;

    expect(id.type).toBe('string');
    // Exact raw forms — underscore-prefixed, small numeric, and full-digit
    // numeric ids all appear verbatim (never coerced or re-formatted).
    expect(id.enum).toEqual(['_4692', '4', '1745118159974']);
  });

  it('pins rating ids as a string enum of the union of rating ids, deduplicated in order', () => {
    const schema = buildGradeSubmissionResponseSchema(criteria);
    const ratingID = schema.properties!.Rubrics!.items!.properties!.ratingID!;

    expect(ratingID.type).toBe('string');
    expect(ratingID.enum).toEqual(['_817', '_818', 'blank', 'blank_2']);
  });

  it('declares the byte-exact top-level and item keys with required lists', () => {
    const schema = buildGradeSubmissionResponseSchema(criteria);

    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties!)).toEqual([
      'TotalPoints',
      'assignmentFeedback',
      'Rubrics',
    ]);
    expect(schema.required).toEqual(['TotalPoints', 'assignmentFeedback', 'Rubrics']);
    expect(schema.properties!.TotalPoints!.type).toBe('string');
    expect(schema.properties!.assignmentFeedback!.type).toBe('string');
    expect(schema.properties!.Rubrics!.type).toBe('array');

    const item = schema.properties!.Rubrics!.items!;
    expect(Object.keys(item.properties!)).toEqual(['id', 'ratingID', 'points', 'ratingFeedback']);
    expect(item.required).toEqual(['id', 'ratingID', 'points', 'ratingFeedback']);
    expect(item.properties!.points!.type).toBe('number');
    expect(item.properties!.ratingFeedback!.type).toBe('string');
  });

  it('omits the enum constraint entirely when no ids exist (no impossible empty enum)', () => {
    const schema = buildGradeSubmissionResponseSchema([]);
    const item = schema.properties!.Rubrics!.items!;
    expect(item.properties!.id!.enum).toBeUndefined();
    expect(item.properties!.ratingID!.enum).toBeUndefined();
  });
});

describe('buildQuizQuestionResponseSchema', () => {
  it('declares the byte-exact quiz keys', () => {
    const schema = buildQuizQuestionResponseSchema();
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties!)).toEqual(['score', 'comment']);
    expect(schema.required).toEqual(['score', 'comment']);
    expect(schema.properties!.score!.type).toBe('number');
    expect(schema.properties!.comment!.type).toBe('string');
  });
});

/** Walks a schema and asserts strict mode at every object node. */
function assertStrict(node: JsonSchema, path: string): void {
  if (node.type === 'object') {
    expect(node.additionalProperties, `${path}: additionalProperties`).toBe(false);
    expect([...(node.required ?? [])].sort(), `${path}: required`).toEqual(
      Object.keys(node.properties ?? {}).sort(),
    );
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      assertStrict(child, `${path}.${key}`);
    }
  }
  if (node.type === 'array' && node.items) assertStrict(node.items, `${path}[]`);
}

describe('strict output schemas (codex exec --output-schema)', () => {
  it('every object node sets additionalProperties:false and requires every property', () => {
    assertStrict(buildGradeSubmissionResponseSchema(criteria), 'grade_submission');
    assertStrict(buildGradeSubmissionResponseSchema([]), 'grade_submission(no rubric)');
    assertStrict(buildQuizQuestionResponseSchema(), 'grade_quiz_question');
    assertStrict(buildAlignmentResponseSchema(), 'report_alignment');
  });

  it('uses only lowercase JSON Schema type names', () => {
    const allowed = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
    const walk = (node: JsonSchema): void => {
      expect(allowed.has(node.type)).toBe(true);
      Object.values(node.properties ?? {}).forEach(walk);
      if (node.items) walk(node.items);
    };
    walk(buildGradeSubmissionResponseSchema(criteria));
    walk(buildQuizQuestionResponseSchema());
    walk(buildAlignmentResponseSchema());
  });
});

describe('GraderOutputSchema (validation gate)', () => {
  const valid = {
    TotalPoints: '18/20',
    assignmentFeedback: 'Solid work overall.',
    Rubrics: [
      { id: '_4692', ratingID: '_817', points: 5, ratingFeedback: 'Clear thesis.' },
      { id: '4', ratingID: 'blank', points: 3.5, ratingFeedback: 'Good sourcing.' },
    ],
  };

  it('accepts a valid output and preserves raw string ids', () => {
    const parsed = GraderOutputSchema.parse(valid);
    expect(parsed.Rubrics[0]!.id).toBe('_4692');
    expect(parsed.Rubrics[0]!.ratingID).toBe('_817');
    expect(parsed.TotalPoints).toBe('18/20');
  });

  it('normalizes model-emitted numeric ids to digit-exact strings (C# NumberOrStringJsonConverter)', () => {
    const parsed = RubricItemSchema.parse({
      id: 1745118159974,
      ratingID: 4,
      points: 2,
      ratingFeedback: 'ok',
    });
    expect(parsed.id).toBe('1745118159974');
    expect(parsed.ratingID).toBe('4');
  });

  it('rejects wrong key casing (totalPoints is not TotalPoints)', () => {
    const wrongKeys = {
      totalPoints: '18/20',
      assignmentFeedback: 'x',
      Rubrics: [],
    };
    expect(GraderOutputSchema.safeParse(wrongKeys).success).toBe(false);
  });

  it('enforces the "score/total" TotalPoints format', () => {
    expect(GraderOutputSchema.safeParse({ ...valid, TotalPoints: '18 of 20' }).success).toBe(false);
    expect(GraderOutputSchema.safeParse({ ...valid, TotalPoints: '18.5/20' }).success).toBe(true);
    expect(GraderOutputSchema.safeParse({ ...valid, TotalPoints: '/20' }).success).toBe(false);
  });

  it('rejects empty feedback and negative points', () => {
    expect(GraderOutputSchema.safeParse({ ...valid, assignmentFeedback: '' }).success).toBe(false);
    expect(
      GraderOutputSchema.safeParse({
        ...valid,
        Rubrics: [{ id: '1', ratingID: '2', points: -1, ratingFeedback: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      GraderOutputSchema.safeParse({
        ...valid,
        Rubrics: [{ id: '1', ratingID: '2', points: 1, ratingFeedback: '' }],
      }).success,
    ).toBe(false);
  });
});

describe('QuizQuestionGraderOutputSchema (validation gate)', () => {
  it('accepts a valid quiz grade', () => {
    const parsed = QuizQuestionGraderOutputSchema.parse({ score: 4.5, comment: 'Good detail.' });
    expect(parsed.score).toBe(4.5);
  });

  it('rejects negative scores, empty comments, and wrong keys', () => {
    expect(QuizQuestionGraderOutputSchema.safeParse({ score: -1, comment: 'x' }).success).toBe(
      false,
    );
    expect(QuizQuestionGraderOutputSchema.safeParse({ score: 1, comment: '' }).success).toBe(false);
    expect(QuizQuestionGraderOutputSchema.safeParse({ Score: 1, comment: 'x' }).success).toBe(
      false,
    );
  });
});

describe('clampQuizScore', () => {
  it('clamps to [0, maxPoints] and zeroes non-finite scores', () => {
    expect(clampQuizScore(4, 5)).toBe(4);
    expect(clampQuizScore(7, 5)).toBe(5);
    expect(clampQuizScore(-2, 5)).toBe(0);
    expect(clampQuizScore(Number.NaN, 5)).toBe(0);
    expect(clampQuizScore(Number.POSITIVE_INFINITY, 5)).toBe(0);
  });
});
