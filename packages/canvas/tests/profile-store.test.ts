// ProfileStore behavior: the never-null contract (missing/corrupt/future-
// version files yield fully-defaulted profiles), the AIGrader.json filename
// compat contract, schemaVersion stamping on save, and import-from-another-
// course (which must never import defaults or carry Canvas outcome ids).
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\ProfileStore.cs

import { describe, expect, it, vi } from 'vitest';
import { serializeStorageDocument } from '@aigrader/shared';
import { CourseDocumentStore, ROOT_FOLDER_NAME } from '../src/stores/course-doc-store.js';
import { PROFILE_FILENAME, ProfileStore } from '../src/stores/profile-store.js';
import { FakeFilesClient } from './stores-helpers.js';

function makeProfileStore() {
  const files = new FakeFilesClient();
  const warnings: string[] = [];
  const store = new CourseDocumentStore({ files, warn: (m) => warnings.push(m) });
  const profiles = new ProfileStore(store);
  return { files, store, profiles, warnings };
}

function seedProfile(files: FakeFilesClient, courseId: number, doc: unknown): void {
  files.seedFile(courseId, ROOT_FOLDER_NAME, PROFILE_FILENAME, serializeStorageDocument(doc));
}

const storedProfile = {
  schemaVersion: 1,
  courseProfile: { courseLevel: '300', gradingPhilosophy: 'Reward evidence.' },
  gradingDefaults: { strictness: 80 },
  canvasOutcomes: [{ id: 42, title: 'Outcome A', description: '' }],
  commonMistakes: ['missing citations'],
};

describe('the filename compat contract', () => {
  it('stays "AIGrader.json" (shared with both predecessor apps)', () => {
    expect(PROFILE_FILENAME).toBe('AIGrader.json');
  });
});

describe('get (never-null contract)', () => {
  it('returns a fully-defaulted profile when no file exists', async () => {
    const { profiles } = makeProfileStore();

    const profile = await profiles.get(9);

    expect(profile.schemaVersion).toBe(1);
    expect(profile.gradingDefaults.strictness).toBe(55);
    expect(profile.gradingDefaults.humanInTheLoop).toBe(true);
    expect(profile.courseProfile.feedbackTone).toBe('supportive_direct');
    expect(profile.canvasOutcomes).toEqual([]);
  });

  it('returns defaults for a CORRUPT file instead of throwing', async () => {
    const { files, profiles, warnings } = makeProfileStore();
    files.seedFile(9, ROOT_FOLDER_NAME, PROFILE_FILENAME, '{"schemaVersion": 1, "cut off');

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const profile = await profiles.get(9);
      expect(profile.schemaVersion).toBe(1);
      expect(profile.gradingDefaults.strictness).toBe(55);
    } finally {
      consoleWarn.mockRestore();
    }
    expect(warnings.some((w) => w.includes(PROFILE_FILENAME))).toBe(true);
  });

  it('returns defaults for a FUTURE schemaVersion (never a partial misread)', async () => {
    const { files, profiles } = makeProfileStore();
    seedProfile(files, 9, { ...storedProfile, schemaVersion: 2 });

    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const profile = await profiles.get(9);
      expect(profile.schemaVersion).toBe(1);
      expect(profile.gradingDefaults.strictness).toBe(55); // NOT the stored 80
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('reads a stored v1 profile with defaults filled in for missing fields', async () => {
    const { files, profiles } = makeProfileStore();
    seedProfile(files, 9, storedProfile);

    const profile = await profiles.get(9);

    expect(profile.courseProfile.courseLevel).toBe('300');
    expect(profile.gradingDefaults.strictness).toBe(80);
    expect(profile.gradingDefaults.evidenceExpectation).toBe(70); // defaulted
    expect(profile.canvasOutcomes).toHaveLength(1);
  });
});

describe('exists', () => {
  it('distinguishes "no profile yet" from "default profile"', async () => {
    const empty = makeProfileStore();
    expect(await empty.profiles.exists(9)).toBe(false);
    expect((await empty.profiles.get(9)).schemaVersion).toBe(1); // defaults, yet exists=false

    // Fresh store (the folder decision is cached per course, by design) with
    // a profile already in Canvas.
    const seeded = makeProfileStore();
    seedProfile(seeded.files, 9, storedProfile);
    expect(await seeded.profiles.exists(9)).toBe(true);
  });

  it('counts a future-version file as existing (C# parity)', async () => {
    const { files, profiles } = makeProfileStore();
    seedProfile(files, 9, { schemaVersion: 7, unknownField: true });

    expect(await profiles.exists(9)).toBe(true);
  });
});

describe('save', () => {
  it('always stamps schemaVersion 1 and writes through the shared serializer', async () => {
    const { files, profiles } = makeProfileStore();
    const profile = await profiles.get(9);
    profile.gradingDefaults.strictness = 91;

    await profiles.save(9, profile);

    const text = files.fileText(9, ROOT_FOLDER_NAME, PROFILE_FILENAME);
    expect(text).not.toBeNull();
    const parsed = JSON.parse(text!) as { schemaVersion: number; gradingDefaults: { strictness: number } };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.gradingDefaults.strictness).toBe(91);
    expect(text).toContain('  "schemaVersion": 1'); // 2-space storage dialect
  });
});

describe('import', () => {
  it('copies the source profile but BLANKS canvasOutcomes (source-course ids are meaningless)', async () => {
    const { files, profiles } = makeProfileStore();
    seedProfile(files, 5, storedProfile);

    const imported = await profiles.import(9, 5);

    expect(imported).not.toBeNull();
    expect(imported!.gradingDefaults.strictness).toBe(80);
    expect(imported!.canvasOutcomes).toEqual([]);

    const target = await profiles.get(9);
    expect(target.courseProfile.gradingPhilosophy).toBe('Reward evidence.');
    expect(target.canvasOutcomes).toEqual([]);
    // The source course was not modified.
    expect((await profiles.get(5)).canvasOutcomes).toHaveLength(1);
  });

  it('returns null when the source has no profile (importing defaults would wipe the target)', async () => {
    const { files, profiles } = makeProfileStore();
    seedProfile(files, 9, storedProfile); // target has real settings

    expect(await profiles.import(9, 5)).toBeNull();

    // Target untouched.
    expect((await profiles.get(9)).gradingDefaults.strictness).toBe(80);
  });

  it('returns null when the source profile is a version we do not understand', async () => {
    const { files, profiles } = makeProfileStore();
    seedProfile(files, 5, { ...storedProfile, schemaVersion: 2 });

    expect(await profiles.import(9, 5)).toBeNull();
    expect(files.fileText(9, ROOT_FOLDER_NAME, PROFILE_FILENAME)).toBeNull();
  });
});
