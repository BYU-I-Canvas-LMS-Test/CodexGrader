// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Models\Storage\AlignmentDocuments.cs
//
// alignment.json — the course alignment audit with HISTORY. The TS predecessor
// kept only the latest report in Redis with a 30-day TTL; preserving update
// history across re-runs is a requirement of this rewrite, so the document
// holds the latest report, a capped list of full prior reports, and summary
// stubs beyond the cap.

import { z } from 'zod';
import { IsoDateTimeSchema } from './storageJson.js';

/** How many full prior reports are retained before demotion to summaries. */
export const ALIGNMENT_HISTORY_CAP = 10;

/** A found/aligned counter pair. */
export const CountPairSchema = z
  .object({
    /** How many exist. */
    found: z.number().int().default(0),
    /** How many are properly aligned/linked. */
    aligned: z.number().int().default(0),
  })
  .passthrough();
export type CountPair = z.infer<typeof CountPairSchema>;

/** Per-assignment audit status within a report. */
export const AssignmentAlignmentStatusSchema = z
  .object({
    canvasAssignmentId: z.number().int(),
    /** Assignment name (survives course copies for display). */
    assignmentName: z.string().default(''),
    /** "reviewed" | "error" | "skipped". */
    status: z.string().default('reviewed'),
    /** This assignment's 0–100 coherence score (AI reviews only). */
    alignmentScore: z.number().int().nullable().default(null),
    /** The AI's one-paragraph summary for this assignment. */
    summary: z.string().nullable().default(null),
  })
  .passthrough();
export type AssignmentAlignmentStatus = z.infer<typeof AssignmentAlignmentStatusSchema>;

/** One assignment the AI review failed on. */
export const ScanErrorSchema = z
  .object({
    assignment: z.string().default(''),
    message: z.string().default(''),
  })
  .passthrough();
export type ScanError = z.infer<typeof ScanErrorSchema>;

/** One alignment finding (port of the TS AlignmentFinding + issue row). */
export const AlignmentIssueSchema = z
  .object({
    /** "high" | "medium" | "low". */
    severity: z.string().default('medium'),
    /** The assignment the finding concerns. */
    assignment: z.string().default(''),
    /** Which artifact pair disagrees: rubric_outcome | rubric_instructions | outcome_instructions. */
    pairing: z.string().default(''),
    /** Short headline. */
    title: z.string().default(''),
    /** 1–3 sentence explanation. */
    detail: z.string().default(''),
    /** A concrete fix the instructor can act on. */
    suggestion: z.string().default(''),
  })
  .passthrough();
export type AlignmentIssue = z.infer<typeof AlignmentIssueSchema>;

/** One alignment audit (heuristic or AI). */
export const AlignmentReportSchema = z
  .object({
    /** "heuristic" (rule-based counts, no LLM) or "ai" (full review). */
    method: z.string().default('heuristic'),
    scannedAt: IsoDateTimeSchema,
    /** Course outcomes found / aligned-to-rubrics counts. */
    outcomes: CountPairSchema.default({}),
    /** Assignments-with-rubrics found / outcome-linked counts. */
    rubrics: CountPairSchema.default({}),
    /** How many gradable assignments the audit considered. */
    assignmentsScanned: z.number().int().default(0),
    /** How many received a full AI review. */
    reviewed: z.number().int().default(0),
    /** Per-assignment results. */
    assignments: z.array(AssignmentAlignmentStatusSchema).default([]),
    /** Assignments the AI review could not process. */
    scanErrors: z.array(ScanErrorSchema).default([]),
    /** 0–100 overall coherence score. */
    alignmentScore: z.number().int().default(0),
    /** All findings across reviewed assignments. */
    issues: z.array(AlignmentIssueSchema).default([]),
  })
  .passthrough();
export type AlignmentReport = z.infer<typeof AlignmentReportSchema>;

/** Trend stub for an archived report. */
export const AlignmentRunSummarySchema = z
  .object({
    scannedAt: IsoDateTimeSchema,
    /** "heuristic" or "ai". */
    method: z.string().default('ai'),
    alignmentScore: z.number().int().default(0),
    /** Total findings. */
    issueCount: z.number().int().default(0),
    /** High-severity findings. */
    highSeverityCount: z.number().int().default(0),
  })
  .passthrough();
export type AlignmentRunSummary = z.infer<typeof AlignmentRunSummarySchema>;

/** Root of alignment.json. */
export const AlignmentHistoryDocumentSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    /** Course fingerprint — a mismatch (course copy) resets the audit, since
     * the copied course's assignments have new ids and need their own review. */
    canvasCourseId: z.number().int(),
    /** The most recent report. */
    latest: AlignmentReportSchema.nullable().default(null),
    /** Prior FULL reports, newest first, capped at ALIGNMENT_HISTORY_CAP. */
    history: z.array(AlignmentReportSchema).default([]),
    /** Score/count stubs for reports demoted past the cap (trend data stays forever). */
    archive: z.array(AlignmentRunSummarySchema).default([]),
  })
  .passthrough();
export type AlignmentHistoryDocument = z.infer<typeof AlignmentHistoryDocumentSchema>;
