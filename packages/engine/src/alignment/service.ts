// Orchestrates course alignment audits. Two tiers:
//   - HEURISTIC: rule-based counts (outcomes exist? rubrics linked?) with no
//     LLM cost — pre-populates the page in well under a second. NOT persisted
//     (it's a live snapshot; only AI reviews enter the history).
//   - AI REVIEW: up to 12 gradable assignments through the alignment agent
//     (4 at a time), findings aggregated into one report, appended to
//     alignment.json with history via AlignmentStore.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Alignment\
// AlignmentService.cs (scoring rules ported exactly, incl. C# integer
// division for the heuristic score and half-to-even rounding for AI scores).
// Canvas access arrives pre-bound to the course's instance (the client
// factory applied forDomain), so no apiDomain parameter is needed here.

import PQueue from 'p-queue';
import { AlignmentReportSchema } from '@aigrader/shared';
import type { AlignmentReport } from '@aigrader/shared';
import type { CanvasAssignment, CanvasOutcome } from '@aigrader/canvas';
import { stripHtml } from '../grading/prompts/strip-html.js';
import type { AssignmentAlignment } from '../llm/alignment-schemas.js';
import type { AlignmentReviewInput } from './review-agent.js';

/** Cap on assignments per AI review (cost control, port of the C#/TS cap). */
export const MAX_ASSIGNMENTS_PER_REVIEW = 12;

/** Concurrent per-assignment reviews (port of the C#/TS concurrency 4). */
export const REVIEW_CONCURRENCY = 4;

/** Default alignment model / thinking budget, from env. */
export function alignmentModelFromEnv(): { model: string; reasoningEffort: string } {
  return {
    // '' = the backend's default model (the grading model unless overridden).
    model: process.env.AIGRADER_ALIGNMENT_MODEL ?? process.env.AIGRADER_MODEL ?? '',
    reasoningEffort:
      process.env.AIGRADER_ALIGNMENT_REASONING_EFFORT ??
      process.env.AIGRADER_REASONING_EFFORT ??
      'medium',
  };
}

// ---------------------------------------------------------- structural ports --

/** The Canvas surface the audit needs (CanvasClient satisfies this). */
export interface AlignmentCanvasPort {
  getGradableItems(courseId: number): Promise<CanvasAssignment[]>;
  getCourseOutcomes(courseId: number): Promise<CanvasOutcome[]>;
}

/** The persistence surface (AlignmentStore satisfies this). */
export interface AlignmentPersistencePort {
  appendReport(courseId: number, report: AlignmentReport): Promise<unknown>;
}

/** One assignment's AI review — throws on LLM failure (the service records a
 * scanError and continues with the other assignments). */
export type AlignmentReviewFn = (input: AlignmentReviewInput) => Promise<AssignmentAlignment>;

export interface AlignmentServiceDeps {
  canvas: AlignmentCanvasPort;
  store: AlignmentPersistencePort;
  review: AlignmentReviewFn;
  now?: () => Date;
  /** Overrides (tests). */
  maxAssignments?: number;
  concurrency?: number;
  warn?: (message: string) => void;
}

// -------------------------------------------------------------------- helpers --

/** C# (int)Math.Round — MidpointRounding.ToEven (banker's rounding), which
 * JS Math.round is not (it rounds .5 halves up). Pinned by tests. */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function hasRubric(a: CanvasAssignment): boolean {
  return (a.rubric?.length ?? 0) > 0;
}

function rubricHasOutcomeLink(a: CanvasAssignment): boolean {
  return (a.rubric ?? []).some((c) => c.learning_outcome_id != null);
}

/** Outcome ids referenced by any rubric criterion, as strings (ids are
 * number|string on the wire — compare in string space). */
function linkedOutcomeIdsOf(assignments: readonly CanvasAssignment[]): Set<string> {
  const ids = new Set<string>();
  for (const a of assignments) {
    for (const c of a.rubric ?? []) {
      if (c.learning_outcome_id != null) ids.add(String(c.learning_outcome_id));
    }
  }
  return ids;
}

function assignmentName(a: CanvasAssignment): string {
  return a.name ?? `Assignment ${a.id}`;
}

// -------------------------------------------------------------------- service --

export class AlignmentService {
  private readonly canvas: AlignmentCanvasPort;
  private readonly store: AlignmentPersistencePort;
  private readonly review: AlignmentReviewFn;
  private readonly now: () => Date;
  private readonly maxAssignments: number;
  private readonly concurrency: number;
  private readonly warn: (message: string) => void;

  constructor(deps: AlignmentServiceDeps) {
    this.canvas = deps.canvas;
    this.store = deps.store;
    this.review = deps.review;
    this.now = deps.now ?? (() => new Date());
    this.maxAssignments = deps.maxAssignments ?? MAX_ASSIGNMENTS_PER_REVIEW;
    this.concurrency = deps.concurrency ?? REVIEW_CONCURRENCY;
    this.warn = deps.warn ?? ((message) => console.warn(message));
  }

  /**
   * Fast, no-LLM audit from Canvas metadata alone. NOT persisted.
   *
   * Heuristic score (ported exactly): three structural checks — outcomes
   * exist; EVERY gradable assignment has a rubric (and there is at least
   * one); at least one rubric criterion is outcome-linked — each worth a
   * third, with C# integer division (0 → 0, 1 → 33, 2 → 66, 3 → 100).
   * Deliberately simple: it answers "is anything obviously missing", not
   * "is it good" (that's the AI review's job).
   */
  async runHeuristic(courseId: number): Promise<AlignmentReport> {
    const outcomes = await this.canvas.getCourseOutcomes(courseId);
    const assignments = await this.canvas.getGradableItems(courseId);

    const withRubrics = assignments.filter(hasRubric);
    const outcomeLinkedRubrics = withRubrics.filter(rubricHasOutcomeLink).length;
    const linkedOutcomeIds = linkedOutcomeIdsOf(assignments);

    const checks = [
      outcomes.length > 0,
      withRubrics.length === assignments.length && assignments.length > 0,
      outcomeLinkedRubrics > 0,
    ];
    const score = Math.floor(
      (checks.filter(Boolean).length * 100) / Math.max(1, checks.length),
    );

    return AlignmentReportSchema.parse({
      method: 'heuristic',
      scannedAt: this.now().toISOString(),
      outcomes: {
        found: outcomes.length,
        aligned: outcomes.filter((o) => linkedOutcomeIds.has(String(o.id))).length,
      },
      rubrics: { found: withRubrics.length, aligned: outcomeLinkedRubrics },
      assignmentsScanned: assignments.length,
      reviewed: 0,
      alignmentScore: score,
      assignments: assignments.map((a) => ({
        canvasAssignmentId: a.id,
        assignmentName: assignmentName(a),
        status: 'skipped',
      })),
    });
  }

  /** Full AI review; appends the report to alignment.json history. */
  async runAiReview(courseId: number): Promise<AlignmentReport> {
    const outcomes = await this.canvas.getCourseOutcomes(courseId);
    const outcomePairs = outcomes.map((o) => ({
      title: o.title ?? `Outcome ${o.id}`,
      description: stripHtml(o.description ?? ''),
    }));
    const outcomeTitlesById = new Map(
      outcomes.map((o) => [String(o.id), o.title ?? `Outcome ${o.id}`]),
    );

    // Keep the FULL list for the count stats; cap only the AI review set —
    // counting rubrics/outcomes over the capped subset made the dashboard's
    // course-wide quick-scan numbers look contradictory to faculty.
    const allAssignments = await this.canvas.getGradableItems(courseId);
    const assignments = allAssignments.slice(0, this.maxAssignments);

    // Bounded fan-out: `concurrency` assignments in flight at once; results
    // land by index so aggregation keeps assignment order (the C#
    // Task.WhenAll ordering).
    type ReviewOutcome = {
      assignment: CanvasAssignment;
      result: AssignmentAlignment | null;
      error: string | null;
    };
    const queue = new PQueue({ concurrency: this.concurrency });
    const results: ReviewOutcome[] = [];
    await Promise.all(
      assignments.map((assignment, index) =>
        queue.add(async () => {
          try {
            const input: AlignmentReviewInput = {
              assignmentName: assignmentName(assignment),
              instructionsText: stripHtml(assignment.description ?? ''),
              rubric: (assignment.rubric ?? []).map((c) => {
                const linkId =
                  c.learning_outcome_id != null ? String(c.learning_outcome_id) : null;
                return {
                  description: c.description ?? String(c.id),
                  longDescription: c.long_description ?? null,
                  points: c.points ?? 0,
                  outcomeLinked: linkId != null,
                  linkedOutcomeTitle: linkId ? outcomeTitlesById.get(linkId) ?? null : null,
                };
              }),
              outcomes: outcomePairs,
            };
            results[index] = { assignment, result: await this.review(input), error: null };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.warn(`Alignment review failed for assignment ${assignment.id}: ${message}`);
            results[index] = { assignment, result: null, error: message };
          }
        }),
      ),
    );

    const report = AlignmentReportSchema.parse({
      method: 'ai',
      scannedAt: this.now().toISOString(),
      assignmentsScanned: assignments.length,
    });

    for (const { assignment, result, error } of results) {
      const name = assignmentName(assignment);
      if (result == null) {
        report.scanErrors.push({ assignment: name, message: error ?? 'unknown' });
        report.assignments.push({
          canvasAssignmentId: assignment.id,
          assignmentName: name,
          status: 'error',
          alignmentScore: null,
          summary: null,
        });
        continue;
      }

      report.reviewed += 1;
      report.assignments.push({
        canvasAssignmentId: assignment.id,
        assignmentName: name,
        status: 'reviewed',
        alignmentScore: roundHalfToEven(result.alignmentScore),
        summary: result.summary,
      });
      for (const f of result.findings) {
        report.issues.push({
          severity: f.severity,
          assignment: name,
          pairing: f.pairing,
          title: f.title,
          detail: f.detail,
          suggestion: f.suggestion,
        });
      }
    }

    // Counters mirror the heuristic's shape AND its counting base (the whole
    // course, not the reviewed subset) so both report kinds agree.
    const withRubrics = allAssignments.filter(hasRubric);
    const linkedOutcomeIds = linkedOutcomeIdsOf(withRubrics);
    report.outcomes = {
      found: outcomes.length,
      aligned: outcomes.filter((o) => linkedOutcomeIds.has(String(o.id))).length,
    };
    report.rubrics = {
      found: withRubrics.length,
      aligned: withRubrics.filter(rubricHasOutcomeLink).length,
    };

    // Overall score = mean of reviewed assignment scores (0 when nothing reviewed).
    const scores = report.assignments
      .map((a) => a.alignmentScore)
      .filter((s): s is number => s != null);
    report.alignmentScore =
      scores.length > 0
        ? roundHalfToEven(scores.reduce((sum, s) => sum + s, 0) / scores.length)
        : 0;

    await this.store.appendReport(courseId, report);
    return report;
  }
}
