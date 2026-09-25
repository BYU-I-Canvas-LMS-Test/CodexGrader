// RunProgressDoc — the LOCAL progress record for one grading run. The local
// server keeps these in memory (the review page polls them) and persists the
// non-terminal ones to ~/.aigrader/state/active-runs.json so runs resume
// automatically after the server restarts. COUNTS/STATUS/HEARTBEAT and IDS
// ONLY — never student content, never names. The Canvas run document is the
// durable truth; this record only says which runs exist and where they live.

import { z } from 'zod';
import { RunStatusSchema } from './grading-run.js';
import { IsoDateTimeSchema } from './storageJson.js';

/** Per-status row counts — the review screen's progress bar in one object. */
export const RunProgressCountsSchema = z
  .object({
    total: z.number().int().nonnegative().default(0),
    pending: z.number().int().nonnegative().default(0),
    extracting: z.number().int().nonnegative().default(0),
    scoring: z.number().int().nonnegative().default(0),
    drafted: z.number().int().nonnegative().default(0),
    edited: z.number().int().nonnegative().default(0),
    approved: z.number().int().nonnegative().default(0),
    posted: z.number().int().nonnegative().default(0),
    errors: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type RunProgressCounts = z.infer<typeof RunProgressCountsSchema>;

/** Mirror of the Canvas-doc RunLock (operational check; the Canvas doc is truth).
 * A heartbeat staler than ~150s means the owning process is gone. */
export const RunProgressWorkerSchema = z
  .object({
    /** Owning process identifier (hostname:uuid). */
    owner: z.string().default(''),
    heartbeatAt: IsoDateTimeSchema.nullable().default(null),
    /** How many times the run has been resumed (crash-resume telemetry). */
    resumeCount: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type RunProgressWorker = z.infer<typeof RunProgressWorkerSchema>;

/** When the Canvas run document last checkpointed successfully. */
export const RunProgressCheckpointSchema = z
  .object({
    lastSavedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .passthrough();
export type RunProgressCheckpoint = z.infer<typeof RunProgressCheckpointSchema>;

/** One run's local progress record. */
export const RunProgressDocSchema = z
  .object({
    runId: z.string().min(1),
    canvasCourseId: z.number().int(),
    canvasAssignmentId: z.number().int(),
    /** Canvas host the run targets; null = the teacher's primary instance. */
    apiDomain: z.string().nullable().default(null),
    /** The course address ("host#courseId") — the web routes authorize a
     * run by matching this against the course being viewed. */
    courseKey: z.string().default(''),
    /** Same enum (and SNAKE_UPPER strings) as the Canvas run document. */
    status: RunStatusSchema.default('PENDING'),
    counts: RunProgressCountsSchema.default({}),
    /** Cancellation flag — consumers check per item; a resume after a crash
     * finalizes it. Never touches POSTED rows. */
    cancelRequested: z.boolean().default(false),
    worker: RunProgressWorkerSchema.default({}),
    checkpoint: RunProgressCheckpointSchema.default({}),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    /** True when this process only OPENED the run (another laptop's, or one
     * the C# app wrote) — never auto-resumed, never persisted. Cleared the
     * moment this process resumes it (the live writer omits the flag). */
    adopted: z.boolean().optional(),
  })
  .passthrough();
export type RunProgressDoc = z.infer<typeof RunProgressDocSchema>;
