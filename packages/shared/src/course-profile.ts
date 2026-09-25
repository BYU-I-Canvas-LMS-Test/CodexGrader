// Ported from: C:\Devs\AIgrader\lib\canvas\course-profile.ts
// Cross-checked against: C:\Devs\AIGrader-C#\src\AiGrader\Models\Storage\CourseSettingsProfile.cs
//
// Course "AI Profile" — the per-course grading calibration the faculty member
// configures on the Create AI Profile screen. Stored as AIGrader.json in the
// hidden "AI Grader" Canvas folder — the SAME name, location, and
// schemaVersion both predecessor apps used, so existing course profiles keep
// working with zero migration.
//
// RECONCILED SUPERSET of the TS predecessor's Zod schema and the C# model:
//   - canvasOutcomes (TS): outcome ids stay number|string exactly as stored
//     (the C# reader accepts both via NumberOrStringJsonConverter).
//   - assignmentOverrides (C#): per-assignment raw-JSON overrides that this
//     app does not interpret yet — they round-trip untouched so the base C#
//     app's data is never lost.
// Every object is .passthrough() so fields a newer build writes survive a
// read-modify-write here.
//
// COMPATIBILITY RULES — do not break these:
//   1. schemaVersion stays 1 (a parity contract with the C# app).
//      Legacy readers silently fall back to ALL DEFAULTS for any other value.
//   2. Changes must be additive (new optional fields only).

import { z } from 'zod';

export const COURSE_PROFILE_SCHEMA_VERSION = 1;

export const FEEDBACK_LENGTHS = ['short', 'medium', 'long'] as const;

export const CourseProfileSectionSchema = z
  .object({
    courseLevel: z.string().nullable().default(null),
    courseType: z.string().nullable().default(null),
    genEd: z.boolean().default(false),
    learningOutcomes: z.array(z.string()).max(5).default([]),
    strongWorkDefinition: z.string().default(''),
    gradingPhilosophy: z.string().default(''),
    feedbackTone: z.string().default('supportive_direct'),
    studentAiPolicy: z.string().default('not_set'),
  })
  .passthrough();

export const WritingExpectationsSchema = z
  .object({
    grammarWeight: z.number().int().min(0).max(100).default(50),
    organizationWeight: z.number().int().min(0).max(100).default(50),
    citationWeight: z.number().int().min(0).max(100).default(50),
    clarityWeight: z.number().int().min(0).max(100).default(70),
  })
  .passthrough();

export const GradingDefaultsSchema = z
  .object({
    overallFeedbackLength: z.enum(FEEDBACK_LENGTHS).default('short'),
    rubricFeedbackLength: z.enum(FEEDBACK_LENGTHS).default('short'),
    strictness: z.number().int().min(0).max(100).default(55),
    evidenceExpectation: z.number().int().min(0).max(100).default(70),
    missingWorkPenalty: z.number().int().min(0).max(100).default(75),
    humanInTheLoop: z.boolean().default(true),
  })
  .passthrough();

export const CustomPhrasesSchema = z
  .object({
    vagueButClose: z.string().default(''),
    praiseMostOften: z.string().default(''),
    correctMostOften: z.string().default(''),
  })
  .passthrough();

// A course's actual Canvas learning outcomes, cached here so the grader and
// alignment can read them offline. Synced from Canvas whenever the instructor
// views/manages outcomes. Replaces the free-text courseProfile.learningOutcomes
// as the source of truth (that field is retained for back-compat/fallback).
//
// `id` is number|string ON THE WIRE: this TS lineage wrote numbers, the C# app
// normalizes to strings. Never coerce — round-trip exactly as stored.
export const CanvasOutcomeRefSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    description: z.string().default(''),
  })
  .passthrough();
export type CanvasOutcomeRef = z.infer<typeof CanvasOutcomeRefSchema>;

export const CourseSettingsProfileSchema = z
  .object({
    schemaVersion: z
      .literal(COURSE_PROFILE_SCHEMA_VERSION)
      .default(COURSE_PROFILE_SCHEMA_VERSION),
    courseProfile: CourseProfileSectionSchema.default({}),
    writingExpectations: WritingExpectationsSchema.default({}),
    gradingDefaults: GradingDefaultsSchema.default({}),
    customPhrases: CustomPhrasesSchema.default({}),
    commonMistakes: z.array(z.string()).default([]),
    canvasOutcomes: z.array(CanvasOutcomeRefSchema).default([]),
    // Per-assignment setting overrides, retained from the base C# app's
    // schema. Kept as raw JSON because this app does not interpret them yet —
    // they round-trip untouched so the C# app's data is never lost.
    assignmentOverrides: z.record(z.unknown()).default({}),
  })
  .passthrough();

export type CourseSettingsProfile = z.infer<typeof CourseSettingsProfileSchema>;

// Parse stored JSON (or null/legacy) into a fully-defaulted profile. Runs
// inside the grader path, so it must never throw on a structurally-invalid
// stored document (e.g. a future schemaVersion): fall back to a clean default
// and warn.
export function parseCourseProfile(stored: unknown): CourseSettingsProfile {
  const result = CourseSettingsProfileSchema.safeParse(stored ?? {});
  if (result.success) return result.data;
  console.warn(
    '[course-profile] stored gradingProfile failed validation; using defaults:',
    result.error.message,
  );
  return CourseSettingsProfileSchema.parse({});
}

// Flatten a profile into the calibration text the grader system prompt
// expects (the C# MVP serialized CourseSettingsJson; this is the readable
// equivalent). Only emits lines that carry signal.
// VERBATIM port — output is pinned by golden tests; do not adjust wording or
// whitespace.
export function renderCourseProfileText(profile: CourseSettingsProfile): string {
  const {
    courseProfile: cp,
    gradingDefaults: gd,
    customPhrases: cph,
    writingExpectations: we,
  } = profile;
  const lines: string[] = [];

  if (cp.courseLevel) lines.push(`Course level: ${cp.courseLevel}`);
  if (cp.courseType) lines.push(`Course type: ${cp.courseType}`);
  if (cp.genEd) lines.push('This is a General Education course.');
  if (cp.gradingPhilosophy) {
    lines.push(`Grading philosophy: ${cp.gradingPhilosophy}`);
  }
  if (cp.strongWorkDefinition) {
    lines.push(`What strong work looks like: ${cp.strongWorkDefinition}`);
  }
  if (cp.feedbackTone) lines.push(`Feedback tone: ${cp.feedbackTone}`);
  lines.push(`Strictness (0 forgiving – 100 very strict): ${gd.strictness}`);
  lines.push(
    `Evidence expectation (0–100): ${gd.evidenceExpectation}; missing-work penalty (0–100): ${gd.missingWorkPenalty}`,
  );
  lines.push(
    `Overall feedback length: ${gd.overallFeedbackLength}; per-criterion feedback length: ${gd.rubricFeedbackLength}`,
  );
  lines.push(
    `Writing emphasis (0–100): grammar ${we.grammarWeight}, organization ${we.organizationWeight}, citations ${we.citationWeight}, clarity ${we.clarityWeight}`,
  );
  if (cp.studentAiPolicy && cp.studentAiPolicy !== 'not_set') {
    lines.push(`Student AI policy: ${cp.studentAiPolicy}`);
  }
  // Prefer the actual Canvas course outcomes; fall back to the legacy
  // free-text list only when no Canvas outcomes are cached.
  if (profile.canvasOutcomes.length > 0) {
    // Cap how many outcomes enter the prompt — renderCourseProfileText runs per
    // submission, so an outlier course with hundreds of outcomes can't balloon
    // the prompt. The cache itself stays complete for the UI.
    const MAX_PROMPT_OUTCOMES = 50;
    const shown = profile.canvasOutcomes.slice(0, MAX_PROMPT_OUTCOMES);
    lines.push('Learning outcomes (from Canvas):');
    for (const o of shown) {
      lines.push(o.description ? `- ${o.title}: ${o.description}` : `- ${o.title}`);
    }
    if (profile.canvasOutcomes.length > shown.length) {
      lines.push(`- …and ${profile.canvasOutcomes.length - shown.length} more`);
    }
  } else if (cp.learningOutcomes.length > 0) {
    lines.push('Learning outcomes:');
    for (const o of cp.learningOutcomes) lines.push(`- ${o}`);
  }
  if (cph.vagueButClose) {
    lines.push(`When work is vague but close: ${cph.vagueButClose}`);
  }
  if (cph.praiseMostOften) lines.push(`Often praises: ${cph.praiseMostOften}`);
  if (cph.correctMostOften) {
    lines.push(`Often corrects: ${cph.correctMostOften}`);
  }
  if (profile.commonMistakes.length > 0) {
    lines.push(`Common mistakes to watch for: ${profile.commonMistakes.join(', ')}`);
  }

  return lines.join('\n');
}
