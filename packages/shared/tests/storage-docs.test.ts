// storageJson serialization contract + resources/alignment document round-trips.
import { describe, it, expect } from 'vitest';
import {
  serializeStorageDocument,
  parseStorageDocument,
  CourseResourcesDocumentSchema,
  AlignmentHistoryDocumentSchema,
  ALIGNMENT_HISTORY_CAP,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

describe('serializeStorageDocument (StorageJson contract)', () => {
  it('omits null and undefined object properties, like C# WhenWritingNull', () => {
    const out = serializeStorageDocument({
      keep: 'x',
      dropNull: null,
      dropUndefined: undefined,
      nested: { keep: 1, dropNull: null },
    });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ keep: 'x', nested: { keep: 1 } });
    expect(out).not.toContain('dropNull');
  });

  it('keeps null ARRAY ELEMENTS (WhenWritingNull only affects properties)', () => {
    expect(JSON.parse(serializeStorageDocument({ list: [1, null, 'a'] }))).toEqual({
      list: [1, null, 'a'],
    });
  });

  it('writes 2-space-indented JSON, mirroring C# WriteIndented', () => {
    expect(serializeStorageDocument({ a: 1, b: { c: 2 } })).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}',
    );
  });
});

describe('CourseResourcesDocumentSchema', () => {
  it('round-trips a C#-shaped resources.json byte-for-byte', () => {
    const fixture = loadFixture('course-resources.cs.json');
    const parsed = parseStorageDocument(CourseResourcesDocumentSchema, fixture);
    expect(serializeStorageDocument(parsed)).toBe(fixture);
  });

  it('parses ResourceKind SNAKE_UPPER values and the prep dictionary', () => {
    const fixture = loadFixture('course-resources.cs.json');
    const parsed = parseStorageDocument(CourseResourcesDocumentSchema, fixture);
    expect(parsed.resources.map((r) => r.kind)).toEqual(['KEY', 'TEMPLATE']);
    expect(parsed.resources[1]!.contentType).toBeNull();
    expect(parsed.prep['11824']!.shareInstructions).toBe(false);
    expect(parsed.prep['11824']!.shareRubric).toBe(true);
  });

  it('defaults prep settings like the C# model (shareRubric/shareInstructions true)', () => {
    const parsed = CourseResourcesDocumentSchema.parse({
      canvasCourseId: 1,
      prep: { '5': {} },
    });
    expect(parsed.prep['5']).toEqual({
      customInstructions: '',
      shareRubric: true,
      shareInstructions: true,
    });
  });
});

describe('AlignmentHistoryDocumentSchema', () => {
  it('round-trips a C#-shaped alignment.json byte-for-byte', () => {
    const fixture = loadFixture('alignment.cs.json');
    const parsed = parseStorageDocument(AlignmentHistoryDocumentSchema, fixture);
    expect(serializeStorageDocument(parsed)).toBe(fixture);
  });

  it('parses reports, nullable per-assignment scores, and archive stubs', () => {
    const fixture = loadFixture('alignment.cs.json');
    const parsed = parseStorageDocument(AlignmentHistoryDocumentSchema, fixture);
    expect(parsed.latest!.method).toBe('ai');
    expect(parsed.latest!.outcomes).toEqual({ found: 6, aligned: 4 });
    expect(parsed.latest!.assignments[0]!.alignmentScore).toBe(72);
    expect(parsed.latest!.assignments[1]!.alignmentScore).toBeNull();
    expect(parsed.archive[0]!.method).toBe('heuristic');
    expect(ALIGNMENT_HISTORY_CAP).toBe(10);
  });
});
