// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\RubricDraftMapper.cs
// (pinned by tests\AiGrader.Tests\DraftTotalPointsTests.cs — the TS port of
// that suite lives in ../tests/rubric-draft-mapper.test.ts).
//
// Maps the AI's rubric output rows back to the REAL Canvas rubric criteria.
// The matching rule (exact id first, then positional fallback) guarantees the
// ids that reach Canvas are Canvas's own criterion ids in their original
// form, never AI-echoed mutations — Canvas silently drops rubric assessments
// keyed with ids in the wrong form.
//
// PORT DELTA (deliberate, per the governing plan's "clamp to criterion
// maxima" validation-gate rule): awarded points are clamped to
// [0, criterion.points] at mapping time. The strict output schema pins ids
// but cannot bound per-criterion points; the clamp is the guarantee.

import type { GraderDraft, RubricCriterionSnapshot } from '@aigrader/shared';
import type { GraderOutput } from '../llm/response-schemas.js';

/** C# "0.##" invariant formatting: up to 2 decimals, no trailing zeros. */
function formatPoints(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Parses the numeric halves out of an "earned/possible" string. */
function parseTotal(totalPoints: string): { earned: number | null; possible: number | null } {
  const slash = totalPoints.indexOf('/');
  const head = slash >= 0 ? totalPoints.slice(0, slash) : totalPoints;
  const tail = slash >= 0 ? totalPoints.slice(slash + 1) : '';
  const earned = Number.parseFloat(head);
  const possible = Number.parseFloat(tail);
  return {
    earned: Number.isFinite(earned) ? earned : null,
    possible: slash >= 0 && Number.isFinite(possible) ? possible : null,
  };
}

/**
 * Builds a GraderDraft from the validated LLM output, re-keying every rubric
 * row to the rubric snapshot's criterion ids.
 *
 * Matching per criterion: (1) an AI row whose echoed id equals the criterion
 * id exactly; else (2) the AI row at the same index. Criteria with no
 * matching row are omitted (the reviewer sees them unscored rather than
 * zero-filled — absence is information).
 */
export function toDraft(
  output: GraderOutput,
  rubricSnapshot: readonly RubricCriterionSnapshot[],
  pointsPossible: number | null = null,
): GraderDraft {
  const draft: GraderDraft = {
    totalPoints: output.TotalPoints,
    assignmentFeedback: output.assignmentFeedback,
    rubrics: [],
  };

  for (let i = 0; i < rubricSnapshot.length; i++) {
    const criterion = rubricSnapshot[i]!;
    const aiRow =
      output.Rubrics.find((r) => r.id === criterion.id) ??
      (i < output.Rubrics.length ? output.Rubrics[i]! : null);
    if (aiRow == null) continue;

    // Clamp to the criterion's maximum (validation gate — see file header).
    const max = criterion.points;
    const points = max > 0 ? Math.min(Math.max(aiRow.points, 0), max) : Math.max(aiRow.points, 0);

    // The rating id is validated against the criterion's real ratings. An
    // AI-invented id falls back to the rating whose points match the awarded
    // score (the base project's "hallucination fallback"); no match at all
    // degrades to null (points still post).
    const ratings = criterion.ratings ?? [];
    const ratingId =
      ratings.find((rt) => rt.id === aiRow.ratingID)?.id ??
      ratings.find((rt) => Math.abs(rt.points - points) < 0.01)?.id ??
      null;

    draft.rubrics.push({
      criterionId: criterion.id, // ALWAYS the snapshot's id — never the AI echo
      ratingId,
      points,
      ratingFeedback: aiRow.ratingFeedback,
    });
  }

  syncTotalPoints(draft, pointsPossible, rubricSnapshot);
  return draft;
}

/**
 * Rewrites draft.totalPoints so the number faculty see is the number Canvas
 * records. The earned side is the criterion-score sum whenever rubric lines
 * exist (Canvas recomputes rubric-graded submissions from the assessment,
 * ignoring any conflicting posted_grade); the possible side is the
 * assignment's points-possible, falling back to the rubric's max sum, then
 * to the AI's own denominator. The AI's holistic string survives untouched
 * only when nothing better can be derived. Call again after any criterion
 * edit (writeback re-runs it as the last-line truth guard).
 */
export function syncTotalPoints(
  draft: GraderDraft,
  pointsPossible: number | null | undefined,
  rubricSnapshot: readonly RubricCriterionSnapshot[] | null | undefined,
): void {
  const ai = parseTotal(draft.totalPoints);

  const earned =
    draft.rubrics.length > 0
      ? draft.rubrics.reduce((sum, r) => sum + r.points, 0)
      : ai.earned;
  if (earned == null) return; // nothing trustworthy to derive — keep the AI string

  const rubricMax =
    rubricSnapshot && rubricSnapshot.length > 0
      ? rubricSnapshot.reduce((sum, c) => sum + c.points, 0)
      : null;
  const possible =
    pointsPossible != null && pointsPossible > 0
      ? pointsPossible
      : rubricMax != null && rubricMax > 0
        ? rubricMax
        : ai.possible;

  draft.totalPoints =
    possible == null ? formatPoints(earned) : `${formatPoints(earned)}/${formatPoints(possible)}`;
}

/**
 * The scale guarantee for NO-RUBRIC grading, mirroring the quiz path's
 * contract ("the prompt instructs the range but the clamp is the guarantee"):
 * the drafted score can never exceed the assignment's points-possible. A
 * holistic score on an invented denominator ("17/20" for a 5-point
 * assignment — the reported field bug) is rescaled proportionally to the
 * real scale; an overshoot on the right denominator is clamped. Returns a
 * faculty-visible warning describing the correction, or null when the output
 * was already on-scale.
 *
 * Call BEFORE toDraft: the correction needs the model's own denominator,
 * which syncTotalPoints overwrites with the assignment's. Rubric runs are
 * untouched — there the criterion scores are the grade, their validity is
 * the rubric's own scale, and hiding a rubric/assignment point mismatch here
 * would falsify what Canvas records.
 * Ported from: RubricDraftMapper.cs EnforceAssignmentScale.
 */
export function enforceAssignmentScale(
  output: { TotalPoints: string },
  rubricSnapshot: readonly RubricCriterionSnapshot[] | null | undefined,
  pointsPossible: number | null | undefined,
): string | null {
  if (rubricSnapshot && rubricSnapshot.length > 0) return null;
  if (!(pointsPossible != null && pointsPossible > 0)) return null;

  const ai = parseTotal(output.TotalPoints);
  if (ai.earned == null || ai.possible == null) return null;

  const possible = pointsPossible;
  const wrongDenominator = Math.abs(ai.possible - possible) >= 0.005;
  // On-scale (earned is never negative — the schema's "x/y" pattern has no sign).
  if (!wrongDenominator && ai.earned <= possible) return null;

  const original = output.TotalPoints;
  let corrected =
    wrongDenominator && ai.possible > 0
      ? ai.earned * (possible / ai.possible) // keep the model's judgment as a proportion of its own scale
      : ai.earned;
  corrected = Math.round(Math.min(Math.max(corrected, 0), possible) * 100) / 100;

  output.TotalPoints = `${formatPoints(corrected)}/${formatPoints(possible)}`;
  return (
    `The AI returned a score of ${original}, but the assignment is worth ` +
    `${formatPoints(possible)} points — the draft was adjusted to ${output.TotalPoints}. ` +
    'Please double-check the score.'
  );
}

/**
 * True when the rubric mixes underscore-string ids with purely numeric ids —
 * the condition for appending the mixed-id prompt clause.
 */
export function hasMixedIds(rubric: readonly RubricCriterionSnapshot[]): boolean {
  if (rubric.length === 0) return false;
  const hasUnderscore = rubric.some((c) => c.id.startsWith('_'));
  const hasNumeric = rubric.some((c) => /^\d+$/.test(c.id));
  return hasUnderscore && hasNumeric;
}
