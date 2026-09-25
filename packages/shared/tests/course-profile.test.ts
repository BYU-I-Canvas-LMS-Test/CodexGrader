// Ported from: C:\Devs\AIgrader\tests\unit\course-profile.test.ts
// (plus new cross-app round-trip coverage for the C#-shaped document).
import { describe, it, expect } from 'vitest';
import {
  CourseSettingsProfileSchema,
  parseCourseProfile,
  renderCourseProfileText,
  COURSE_PROFILE_SCHEMA_VERSION,
  parseStorageDocument,
  serializeStorageDocument,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

describe('CourseSettingsProfileSchema', () => {
  it('fills a fully-defaulted profile from empty / null input', () => {
    const fromNull = parseCourseProfile(null);
    const fromEmpty = parseCourseProfile({});
    expect(fromNull).toEqual(fromEmpty);
    expect(fromNull.schemaVersion).toBe(COURSE_PROFILE_SCHEMA_VERSION);
    expect(fromNull.courseProfile.learningOutcomes).toEqual([]);
    expect(fromNull.gradingDefaults.strictness).toBe(55);
    expect(fromNull.gradingDefaults.humanInTheLoop).toBe(true);
  });

  it('preserves provided fields and defaults the rest', () => {
    const p = parseCourseProfile({
      courseProfile: {
        courseLevel: 'Advanced',
        learningOutcomes: ['Design efficient programs', 'Apply data structures'],
        gradingPhilosophy: 'Depth over perfection.',
      },
      gradingDefaults: { strictness: 80 },
    });
    expect(p.courseProfile.courseLevel).toBe('Advanced');
    expect(p.courseProfile.learningOutcomes).toHaveLength(2);
    expect(p.gradingDefaults.strictness).toBe(80);
    // untouched fields still defaulted
    expect(p.gradingDefaults.evidenceExpectation).toBe(70);
    expect(p.customPhrases.vagueButClose).toBe('');
  });

  it('rejects more than 5 learning outcomes', () => {
    const result = CourseSettingsProfileSchema.safeParse({
      courseProfile: { learningOutcomes: ['a', 'b', 'c', 'd', 'e', 'f'] },
    });
    expect(result.success).toBe(false);
  });

  it('clamps are enforced on slider weights (0–100)', () => {
    const result = CourseSettingsProfileSchema.safeParse({
      gradingDefaults: { strictness: 150 },
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a C#-shaped AIGrader.json byte-for-byte', () => {
    const fixture = loadFixture('course-profile.cs.json');
    const parsed = parseStorageDocument(CourseSettingsProfileSchema, fixture);
    expect(serializeStorageDocument(parsed)).toBe(fixture);
  });

  it('round-trips assignmentOverrides raw JSON untouched (C# base-app data)', () => {
    const fixture = loadFixture('course-profile.cs.json');
    const parsed = parseStorageDocument(CourseSettingsProfileSchema, fixture);
    expect(parsed.assignmentOverrides).toEqual({
      '11824': {
        strictness: 95,
        note: 'raw JSON from the base C# app - round-trips untouched',
      },
    });
  });

  it('accepts canvasOutcome ids as number OR string and never coerces', () => {
    const parsed = parseCourseProfile({
      canvasOutcomes: [
        { id: 1745118159974, title: 'Numeric id' },
        { id: '_4692', title: 'String id' },
      ],
    });
    expect(parsed.canvasOutcomes[0]!.id).toBe(1745118159974);
    expect(parsed.canvasOutcomes[1]!.id).toBe('_4692');
    const reparsed = JSON.parse(serializeStorageDocument(parsed));
    expect(reparsed.canvasOutcomes[0].id).toBe(1745118159974);
    expect(reparsed.canvasOutcomes[1].id).toBe('_4692');
  });

  it('adds assignmentOverrides: {} when rewriting a TS-predecessor document', () => {
    // The TS predecessor never wrote assignmentOverrides; the merged schema
    // defaults it so the C# app always finds the member present.
    const parsed = parseCourseProfile({ schemaVersion: 1, commonMistakes: [] });
    expect(parsed.assignmentOverrides).toEqual({});
    expect(serializeStorageDocument(parsed)).toContain('"assignmentOverrides": {}');
  });

  it('preserves unknown fields written by a future build (passthrough)', () => {
    const parsed = parseCourseProfile({ futureField: 'keep-me' });
    expect((parsed as Record<string, unknown>).futureField).toBe('keep-me');
    expect(JSON.parse(serializeStorageDocument(parsed)).futureField).toBe('keep-me');
  });
});

describe('renderCourseProfileText', () => {
  it('renders only lines that carry signal', () => {
    const text = renderCourseProfileText(
      parseCourseProfile({
        courseProfile: {
          gradingPhilosophy: 'Reward clear reasoning.',
          learningOutcomes: ['Write maintainable code'],
        },
        gradingDefaults: { strictness: 40 },
      }),
    );
    expect(text).toContain('Grading philosophy: Reward clear reasoning.');
    expect(text).toContain('Strictness (0 forgiving – 100 very strict): 40');
    expect(text).toContain('- Write maintainable code');
    // empty optional fields should not appear
    expect(text).not.toContain('When work is vague but close:');
  });

  it('returns a stable, non-empty string for a populated profile', () => {
    const text = renderCourseProfileText(
      parseCourseProfile({ courseProfile: { courseLevel: 'Intermediate' } }),
    );
    expect(text).toContain('Course level: Intermediate');
    expect(text.length).toBeGreaterThan(0);
  });

  it('prefers cached Canvas outcomes over the legacy free-text list', () => {
    const text = renderCourseProfileText(
      parseCourseProfile({
        courseProfile: { learningOutcomes: ['legacy outcome'] },
        canvasOutcomes: [{ id: 1, title: 'Real outcome', description: 'From Canvas.' }],
      }),
    );
    expect(text).toContain('Learning outcomes (from Canvas):');
    expect(text).toContain('- Real outcome: From Canvas.');
    expect(text).not.toContain('legacy outcome');
  });
});
