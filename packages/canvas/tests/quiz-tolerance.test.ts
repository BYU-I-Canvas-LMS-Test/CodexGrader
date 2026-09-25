// Regression tests for the quiz-DTO deserialization failure that blocked ALL
// quiz grading in the C# app: Canvas serves `position` (and `attempt`) as
// null, a string, or a decimal depending on quiz engine and question
// placement, and int-pinned DTOs turned that drift into a failed grading run.
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\QuizDtoToleranceTests.cs

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { quizQuestionSchema, quizSubmissionRefSchema } from '../src/types.js';

describe('quiz DTO tolerance', () => {
  it('deserializes the exact failure shape from the field: position arrives null', () => {
    const list = z
      .array(quizQuestionSchema)
      .parse(
        JSON.parse(
          '[{"id": 1, "position": null, "question_type": "essay_question", "points_possible": 5}]',
        ),
      );

    expect(list[0].position).toBeNull();
    expect(list[0].points_possible).toBe(5);
  });

  it.each([
    ['"3"', 3],
    ['2.0', 2],
    ['7', 7],
  ])('string and decimal position spellings both land as ints: %s → %d', (positionJson, expected) => {
    const q = quizQuestionSchema.parse(
      JSON.parse(`{"id": 1, "position": ${positionJson}, "points_possible": 5}`),
    );
    expect(q.position).toBe(expected);
  });

  it('deserializes untaken quiz submissions carrying a literal null attempt', () => {
    const list = z.array(quizSubmissionRefSchema).parse(
      JSON.parse(
        '[{"id": 10, "user_id": 1, "attempt": null, "workflow_state": "untaken"},' +
          ' {"id": 11, "user_id": 2, "attempt": 1, "workflow_state": "complete"}]',
      ),
    );

    expect(list[0].attempt).toBeNull();
    expect(list[1].attempt).toBe(1);
  });

  it('degrades junk token types to null instead of failing the response', () => {
    const q = quizQuestionSchema.parse(
      JSON.parse('{"id": 1, "position": {"weird": true}, "points_possible": 5}'),
    );

    expect(q.position).toBeNull();
    expect(q.points_possible).toBe(5); // fields after the skipped token still bind
  });
});
