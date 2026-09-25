// Domain store for the course AI Profile (AIGrader.json). Thin by design:
// the document store does the heavy lifting; this layer owns the filename,
// the never-null contract, and profile import.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Storage\ProfileStore.cs
// (whose semantics came from C:\Devs\AIgrader\lib\canvas\course-files.ts
// readProfileFile/writeProfileFile and app\api\courses\[courseId]\profile\*).

import { z } from 'zod';
import {
  COURSE_PROFILE_SCHEMA_VERSION,
  CourseSettingsProfileSchema,
  parseCourseProfile,
} from '@aigrader/shared';
import type { CourseSettingsProfile } from '@aigrader/shared';
import type { CourseDocumentStore } from './course-doc-store.js';

/** The profile filename. Shared with BOTH predecessor apps — never rename
 * (compatibility contract; the folder was rebranded, the file was not). */
export const PROFILE_FILENAME = 'AIGrader.json';

// Existence/raw reads use a loose object schema so a document written by a
// FUTURE schema version still counts as "exists" (matching the C# reader,
// which deserialized loosely and only checked schemaVersion in GetAsync).
const rawDocumentSchema = z.object({}).passthrough();

/** Reads and writes the per-course AI Profile.
 * `apiDomain` on every method names the Canvas instance the course lives on
 * (omitted = the document store's bound default; null = the client's base). */
export class ProfileStore {
  constructor(private readonly store: CourseDocumentStore) {}

  /**
   * Loads the course profile. NEVER null — a missing, corrupt, or
   * future-schemaVersion file yields a fully-defaulted profile (via the
   * shared parseCourseProfile, the TS lineage's Zod literal(1) semantics),
   * so the grader and the wizard always have a complete object to work with.
   */
  async get(courseId: number, apiDomain?: string | null): Promise<CourseSettingsProfile> {
    const raw = await this.store.get(courseId, PROFILE_FILENAME, rawDocumentSchema, apiDomain);
    // schemaVersion != 1 means a future writer we don't understand; the safe
    // behavior is defaults, NOT a partial read that silently misinterprets
    // fields — parseCourseProfile enforces exactly that.
    return parseCourseProfile(raw);
  }

  /** True when an AIGrader.json actually exists for the course (lets the UI
   * distinguish "no profile yet" from "default profile"). */
  async exists(courseId: number, apiDomain?: string | null): Promise<boolean> {
    return (await this.store.get(courseId, PROFILE_FILENAME, rawDocumentSchema, apiDomain)) !== null;
  }

  /** Saves the profile to the course's hidden folder (overwrite). */
  async save(
    courseId: number,
    profile: CourseSettingsProfile,
    apiDomain?: string | null,
  ): Promise<void> {
    await this.store.exclusive(
      courseId,
      PROFILE_FILENAME,
      () => this.write(courseId, profile, apiDomain),
      apiDomain,
    );
  }

  /**
   * Read-modify-write of the profile, exclusive against save() — e.g. the
   * outcome-ref sync can never revert a profile edit saved a moment earlier.
   * `mutate` returns the next profile, or null to leave the file untouched.
   */
  async update(
    courseId: number,
    mutate: (current: CourseSettingsProfile) => CourseSettingsProfile | null,
    apiDomain?: string | null,
  ): Promise<void> {
    await this.store.exclusive(
      courseId,
      PROFILE_FILENAME,
      async () => {
        const next = mutate(await this.get(courseId, apiDomain));
        if (next) await this.write(courseId, next, apiDomain);
      },
      apiDomain,
    );
  }

  private async write(
    courseId: number,
    profile: CourseSettingsProfile,
    apiDomain?: string | null,
  ): Promise<void> {
    // Writes always carry version 1 — the compatibility contract with the TS
    // predecessor's Zod literal(1) and the base app's reader.
    await this.store.put(
      courseId,
      PROFILE_FILENAME,
      { ...profile, schemaVersion: COURSE_PROFILE_SCHEMA_VERSION },
      apiDomain,
    );
  }

  /**
   * Copies another course's profile into this course. Returns the imported
   * profile, or null when the source course has none (or its profile is a
   * version we don't understand). Both courses must live on the SAME Canvas
   * instance (`apiDomain`) — the import UI only offers the teacher's courses
   * from the launch instance.
   */
  async import(
    targetCourseId: number,
    sourceCourseId: number,
    apiDomain?: string | null,
  ): Promise<CourseSettingsProfile | null> {
    // Existence check first: get() would hand back defaults for a course with
    // no profile, and importing defaults would silently wipe the target's
    // settings.
    const raw = await this.store.get(sourceCourseId, PROFILE_FILENAME, rawDocumentSchema, apiDomain);
    if (raw === null) return null;

    const result = CourseSettingsProfileSchema.safeParse(raw);
    if (!result.success) return null; // wrong schemaVersion / malformed — C#'s null / !=1 path

    // Outcomes belong to the SOURCE course's Canvas outcome records; their
    // ids are meaningless in the target course. Everything else (philosophy,
    // tone, weights, phrases) transfers as-is.
    const source: CourseSettingsProfile = { ...result.data, canvasOutcomes: [] };

    await this.save(targetCourseId, source, apiDomain);
    return source;
  }
}
