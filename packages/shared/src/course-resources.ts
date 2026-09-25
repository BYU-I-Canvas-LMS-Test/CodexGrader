// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Models\Storage\CourseResourcesDocument.cs
//
// resources.json — the course's grading-materials index plus per-assignment
// prep settings. One consolidated document (not per-assignment files) so one
// read warms the whole course; writes are rare teacher actions serialized by
// the document store's per-course gate.
//
// Material BYTES live as sibling Canvas files named a{assignmentId}-key.ext /
// a{assignmentId}-template.ext — the predecessors' flat naming, kept so
// materials they already uploaded are found without migration.

import { z } from 'zod';
import { ResourceKindSchema } from './grading-run.js';
import { IsoDateTimeSchema } from './storageJson.js';

/** Metadata for one uploaded template or grading key. */
export const AssignmentResourceEntrySchema = z
  .object({
    /** The assignment this material belongs to. */
    canvasAssignmentId: z.number().int(),
    /** Assignment name at upload time — survives course copies, enabling relink-by-name. */
    assignmentName: z.string().default(''),
    /** TEMPLATE (student starter) or KEY (answer key). */
    kind: ResourceKindSchema,
    /** The deterministic stored filename, e.g. "a11824-key.xlsx". */
    fileName: z.string().default(''),
    /** The teacher's original filename (display only). */
    originalFilename: z.string().default(''),
    contentType: z.string().nullable().default(null),
    /** Canvas file id, refreshed on every upload. A CACHE, not an identity —
     * downloads resolve by fileName when the id has gone stale (overwrites and
     * course copies can reassign ids). */
    canvasFileId: z.number().int().default(0),
    uploadedAt: IsoDateTimeSchema,
  })
  .passthrough();
export type AssignmentResourceEntry = z.infer<typeof AssignmentResourceEntrySchema>;

/** Per-assignment grading-prep configuration (the Prepare screen's state). */
export const AssignmentPrepSettingsSchema = z
  .object({
    /** Standing per-assignment instructions merged into every run's prompt
     * (the run can add one-off notes on top). */
    customInstructions: z.string().default(''),
    /** Whether the rubric is shared with the AI (off = grade from instructions only). */
    shareRubric: z.boolean().default(true),
    /** Whether the assignment instructions are shared with the AI. */
    shareInstructions: z.boolean().default(true),
  })
  .passthrough();
export type AssignmentPrepSettings = z.infer<typeof AssignmentPrepSettingsSchema>;

/** Root of resources.json. */
export const CourseResourcesDocumentSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    /** Course fingerprint. After a course copy, assignment ids in this file
     * refer to the ORIGIN course's assignments; a mismatch triggers the
     * relink-by-name flow instead of silently mis-associating materials. */
    canvasCourseId: z.number().int(),
    /** Uploaded material metadata (bytes live in sibling Canvas files). */
    resources: z.array(AssignmentResourceEntrySchema).default([]),
    /** Per-assignment prep settings, keyed by Canvas assignment id (string —
     * JSON object keys are strings). */
    prep: z.record(AssignmentPrepSettingsSchema).default({}),
  })
  .passthrough();
export type CourseResourcesDocument = z.infer<typeof CourseResourcesDocumentSchema>;
