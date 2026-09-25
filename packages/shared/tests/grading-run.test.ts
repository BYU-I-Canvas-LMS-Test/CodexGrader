// Round-trip coverage for the ported GradingRunDocument schema against a
// C#-shaped document (the C# app is the functional spec — see
// C:\Devs\AIGrader-C#\src\AiGrader\Models\Storage\GradingRunDocument.cs).
import { describe, it, expect } from 'vitest';
import {
  GradingRunDocumentSchema,
  RunStatusSchema,
  GradeStatusSchema,
  ResourceKindSchema,
  parseStorageDocument,
  serializeStorageDocument,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

const fixture = loadFixture('grading-run.cs.json');

describe('GradingRunDocumentSchema', () => {
  it('round-trips a C#-shaped run document byte-for-byte', () => {
    const parsed = parseStorageDocument(GradingRunDocumentSchema, fixture);
    expect(serializeStorageDocument(parsed)).toBe(fixture);
  });

  it('parses SNAKE_UPPER enum strings exactly as C# serializes them', () => {
    const parsed = parseStorageDocument(GradingRunDocumentSchema, fixture);
    expect(parsed.status).toBe('REVIEWING');
    expect(parsed.grades[0]!.status).toBe('DRAFT');
    expect(parsed.grades[1]!.status).toBe('PENDING');
    // and rejects anything not in the C# enum sets
    expect(RunStatusSchema.safeParse('reviewing').success).toBe(false);
    expect(RunStatusSchema.safeParse('Reviewing').success).toBe(false);
    expect(GradeStatusSchema.safeParse('Posted').success).toBe(false);
    expect(ResourceKindSchema.safeParse('template').success).toBe(false);
    expect(RunStatusSchema.options).toEqual([
      'PENDING', 'RUNNING', 'REVIEWING', 'POSTING', 'COMPLETED', 'FAILED', 'CANCELLED',
    ]);
    expect(GradeStatusSchema.options).toEqual([
      'PENDING', 'EXTRACTING', 'SCORING', 'DRAFT', 'EDITED', 'APPROVED', 'POSTED', 'ERROR',
    ]);
    expect(ResourceKindSchema.options).toEqual(['TEMPLATE', 'KEY']);
  });

  it('keeps rubric criterion/rating ids as RAW strings, both Canvas forms', () => {
    const parsed = parseStorageDocument(GradingRunDocumentSchema, fixture);
    // snapshot ids
    expect(parsed.rubricSnapshot[0]!.id).toBe('_4692');
    expect(parsed.rubricSnapshot[1]!.id).toBe('1745118159974');
    // draft line ids (never coerced to numbers — Canvas silently drops
    // mismatched forms on writeback)
    const lines = parsed.grades[0]!.aiDraft!.rubrics;
    expect(lines[0]!.criterionId).toBe('_4692');
    expect(lines[1]!.criterionId).toBe('1745118159974');
    const rewritten = JSON.parse(serializeStorageDocument(parsed));
    expect(rewritten.rubricSnapshot[1].id).toBe('1745118159974');
    expect(typeof rewritten.grades[0].aiDraft.rubrics[1].criterionId).toBe('string');
    expect(rewritten.grades[0].aiDraft.rubrics[1].criterionId).toBe('1745118159974');
  });

  it('tolerates and preserves unknown fields (forward compatibility)', () => {
    const doc = JSON.parse(fixture);
    doc.futureRootField = { nested: true };
    doc.grades[0].futureGradeField = 'x';
    const parsed = GradingRunDocumentSchema.parse(doc);
    const rewritten = JSON.parse(serializeStorageDocument(parsed));
    expect(rewritten.futureRootField).toEqual({ nested: true });
    expect(rewritten.grades[0].futureGradeField).toBe('x');
  });

  it('parses old documents without pagesCharged (stays undefined, never serialized)', () => {
    const parsed = parseStorageDocument(GradingRunDocumentSchema, fixture);
    expect(parsed.grades[0]!.pagesCharged).toBeUndefined();
    expect(serializeStorageDocument(parsed)).not.toContain('pagesCharged');
  });

  it('round-trips pagesCharged when the metering layer sets it', () => {
    const parsed = parseStorageDocument(GradingRunDocumentSchema, fixture);
    parsed.grades[0]!.pagesCharged = 3;
    const rewritten = JSON.parse(serializeStorageDocument(parsed));
    expect(rewritten.grades[0].pagesCharged).toBe(3);
    expect(rewritten.grades[1].pagesCharged).toBeUndefined();
    // negative page counts are invalid
    expect(
      GradingRunDocumentSchema.safeParse({
        ...JSON.parse(fixture),
        grades: [{ ...JSON.parse(fixture).grades[0], pagesCharged: -1 }],
      }).success,
    ).toBe(false);
  });

  it('fills C# model defaults for members missing from a minimal document', () => {
    const parsed = GradingRunDocumentSchema.parse({
      canvasCourseId: 1,
      canvasAssignmentId: 2,
      createdAt: '2026-07-01T10:00:00+00:00',
      updatedAt: '2026-07-01T10:00:00+00:00',
    });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.status).toBe('PENDING');
    expect(parsed.grades).toEqual([]);
    expect(parsed.quizGrades).toEqual([]);
    expect(parsed.canvasApiDomain).toBeNull();
    expect(parsed.lock).toBeNull();
  });

  it('round-trips quiz-run collections (snapshot + quizGrades)', () => {
    const doc = {
      ...JSON.parse(fixture),
      canvasQuizId: 777,
      quizQuestionSnapshot: [
        {
          questionId: 42,
          questionName: 'Q1',
          questionTextHtml: '<p>Explain.</p>',
          maxPoints: 5,
          correctComments: 'Look for the second law.',
        },
      ],
      grades: [],
      quizGrades: [
        {
          canvasUserId: 1001,
          studentName: 'Student A',
          quizSubmissionId: 9001,
          attempt: 1,
          questionId: 42,
          questionName: 'Q1',
          maxPoints: 5,
          status: 'POSTED',
          aiDraft: { score: 4.5, comment: 'Good.' },
          postedAt: '2026-07-01T11:00:00+00:00',
          updatedAt: '2026-07-01T11:00:00+00:00',
        },
      ],
    };
    const parsed = GradingRunDocumentSchema.parse(doc);
    expect(parsed.canvasQuizId).toBe(777);
    expect(parsed.quizGrades[0]!.status).toBe('POSTED');
    const rewritten = JSON.parse(serializeStorageDocument(parsed));
    expect(rewritten.quizGrades[0].aiDraft.score).toBe(4.5);
    expect(rewritten.quizQuestionSnapshot[0].correctComments).toBe('Look for the second law.');
    // neutralComments was null -> omitted on write, like C#
    expect('neutralComments' in rewritten.quizQuestionSnapshot[0]).toBe(false);
  });
});
