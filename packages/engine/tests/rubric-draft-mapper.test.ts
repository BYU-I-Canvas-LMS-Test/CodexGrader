// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\DraftTotalPointsTests.cs
// (the Score-box honesty rules), plus the id re-key + clamp contract of
// RubricDraftMapper.ToDraft. Field bugs covered: (1) the AI's holistic total
// disagreed with its own criterion scores; (2) no-rubric items showed "0/0".

import { describe, expect, it } from 'vitest';
import type { GraderDraft, RubricCriterionSnapshot } from '@aigrader/shared';
import {
  enforceAssignmentScale,
  hasMixedIds,
  syncTotalPoints,
  toDraft,
} from '../src/grading/rubric-draft-mapper.js';
import type { GraderOutput } from '../src/llm/response-schemas.js';

function rubric(...maxPoints: number[]): RubricCriterionSnapshot[] {
  return maxPoints.map((points, i) => ({
    id: `_${i + 1}`,
    description: null,
    long_description: null,
    points,
    learning_outcome_id: null,
    ratings: null,
  }));
}

function draftWith(total: string, ...linePoints: number[]): GraderDraft {
  return {
    totalPoints: total,
    assignmentFeedback: '',
    rubrics: linePoints.map((points, i) => ({
      criterionId: `_${i + 1}`,
      ratingId: null,
      points,
      ratingFeedback: '',
    })),
  };
}

describe('syncTotalPoints (DraftTotalPointsTests port)', () => {
  it('RubricDraft_TotalIsCriterionSum: the box shows the sum Canvas records', () => {
    const draft = draftWith('65/115', 24.5, 35, 15, 15);
    syncTotalPoints(draft, 115, rubric(30, 40, 20, 25));
    expect(draft.totalPoints).toBe('89.5/115');
  });

  it('RubricDraft_EditedCriterion_RecomputesTotal', () => {
    const draft = draftWith('65/115', 30, 35, 15, 15);
    syncTotalPoints(draft, 115, rubric(30, 40, 20, 25));
    expect(draft.totalPoints).toBe('95/115');
  });

  it('NoRubric_DenominatorComesFromPointsPossible', () => {
    const draft = draftWith('0/0');
    syncTotalPoints(draft, 1, null);
    expect(draft.totalPoints).toBe('0/1');
  });

  it('RubricDraft_DenominatorFallsBackToRubricMax', () => {
    const draft = draftWith('10/999', 8, 7);
    syncTotalPoints(draft, null, rubric(10, 10));
    expect(draft.totalPoints).toBe('15/20');
  });

  it('NothingDerivable_KeepsAiString', () => {
    const draft = draftWith('see comments');
    syncTotalPoints(draft, 10, null);
    expect(draft.totalPoints).toBe('see comments');
  });
});

describe('toDraft', () => {
  it('ToDraft_NormalizesTotalAtCreation (C# port)', () => {
    const output: GraderOutput = {
      TotalPoints: '65/115',
      assignmentFeedback: 'ok',
      Rubrics: [
        { id: '_1', ratingID: '', points: 24.5, ratingFeedback: 'a' },
        { id: '_2', ratingID: '', points: 35, ratingFeedback: 'b' },
      ],
    };
    const draft = toDraft(output, rubric(30, 40), 70);
    expect(draft.totalPoints).toBe('59.5/70');
  });

  it('re-keys every row to the SNAPSHOT criterion id, never the AI echo', () => {
    const snapshot: RubricCriterionSnapshot[] = [
      {
        id: '_4692',
        description: null,
        long_description: null,
        points: 10,
        learning_outcome_id: null,
        ratings: [
          { id: '_r1', description: null, long_description: null, points: 10 },
          { id: '_r2', description: null, long_description: null, points: 5 },
        ],
      },
      {
        id: '1745118159974',
        description: null,
        long_description: null,
        points: 10,
        learning_outcome_id: null,
        ratings: null,
      },
    ];
    const output: GraderOutput = {
      TotalPoints: '13/20',
      assignmentFeedback: 'ok',
      Rubrics: [
        // AI echoed a mutated id (underscore stripped) — matched positionally.
        { id: '4692', ratingID: '_r2', points: 5, ratingFeedback: 'meh' },
        { id: '1745118159974', ratingID: 'invented', points: 8, ratingFeedback: 'good' },
      ],
    };
    const draft = toDraft(output, snapshot, 20);
    expect(draft.rubrics.map((r) => r.criterionId)).toEqual(['_4692', '1745118159974']);
    // Real rating id survives; the invented one degrades to null (points still post).
    expect(draft.rubrics[0]!.ratingId).toBe('_r2');
    expect(draft.rubrics[1]!.ratingId).toBeNull();
  });

  it('falls back to the rating whose points match when the AI invents a rating id', () => {
    const snapshot: RubricCriterionSnapshot[] = [
      {
        id: '_1',
        description: null,
        long_description: null,
        points: 10,
        learning_outcome_id: null,
        ratings: [
          { id: '_full', description: null, long_description: null, points: 10 },
          { id: '_half', description: null, long_description: null, points: 5 },
        ],
      },
    ];
    const output: GraderOutput = {
      TotalPoints: '5/10',
      assignmentFeedback: 'ok',
      Rubrics: [{ id: '_1', ratingID: 'hallucinated', points: 5, ratingFeedback: 'x' }],
    };
    const draft = toDraft(output, snapshot, 10);
    expect(draft.rubrics[0]!.ratingId).toBe('_half');
  });

  it('omits criteria with no matching AI row (absence is information)', () => {
    const output: GraderOutput = {
      TotalPoints: '8/20',
      assignmentFeedback: 'ok',
      Rubrics: [{ id: '_1', ratingID: '', points: 8, ratingFeedback: 'only one' }],
    };
    const draft = toDraft(output, rubric(10, 10), 20);
    expect(draft.rubrics).toHaveLength(1);
    expect(draft.rubrics[0]!.criterionId).toBe('_1');
  });

  it('clamps awarded points to the criterion maximum (validation gate)', () => {
    const output: GraderOutput = {
      TotalPoints: '99/20',
      assignmentFeedback: 'ok',
      Rubrics: [
        { id: '_1', ratingID: '', points: 45, ratingFeedback: 'over' },
        { id: '_2', ratingID: '', points: 7, ratingFeedback: 'fine' },
      ],
    };
    const draft = toDraft(output, rubric(10, 10), 20);
    expect(draft.rubrics[0]!.points).toBe(10);
    expect(draft.rubrics[1]!.points).toBe(7);
    expect(draft.totalPoints).toBe('17/20'); // synced from the CLAMPED sum
  });
});

describe('hasMixedIds', () => {
  it('detects the mixed underscore/numeric rubric-id condition', () => {
    const mixed: RubricCriterionSnapshot[] = [
      { id: '_4692', description: null, long_description: null, points: 5, learning_outcome_id: null, ratings: null },
      { id: '1745118159974', description: null, long_description: null, points: 5, learning_outcome_id: null, ratings: null },
    ];
    expect(hasMixedIds(mixed)).toBe(true);
    expect(hasMixedIds(mixed.slice(0, 1))).toBe(false);
    expect(hasMixedIds([])).toBe(false);
  });
});


describe('enforceAssignmentScale (DraftTotalPointsTests port — the no-rubric scale guarantee)', () => {
  // Field bug: "17 points out of 5" / "20 points out of 5" drafts — the model
  // graded on an invented scale and nothing brought it back to the
  // assignment's point value.
  const output = (total: string): GraderOutput => ({
    TotalPoints: total,
    assignmentFeedback: 'ok',
    Rubrics: [],
  });

  it('WrongScale_RescalesToAssignmentPoints: 17/20 on a 5-point assignment -> 4.25/5 + warning', () => {
    const o = output('17/20');
    const note = enforceAssignmentScale(o, [], 5);
    expect(o.TotalPoints).toBe('4.25/5');
    expect(note).not.toBeNull();
    expect(note).toContain('17/20');
    expect(note).toContain('4.25/5');
  });

  it('Overshoot_ClampsToPointsPossible: 7/5 -> 5/5 + warning', () => {
    const o = output('7/5');
    const note = enforceAssignmentScale(o, [], 5);
    expect(o.TotalPoints).toBe('5/5');
    expect(note).not.toBeNull();
  });

  it('OnScale_Untouched: 4/5 stays, no warning', () => {
    const o = output('4/5');
    const note = enforceAssignmentScale(o, [], 5);
    expect(o.TotalPoints).toBe('4/5');
    expect(note).toBeNull();
  });

  it('RubricRuns_AreNotTouched: criterion scores are the grade', () => {
    const o = output('17/20');
    const note = enforceAssignmentScale(o, rubric(10, 10), 5);
    expect(o.TotalPoints).toBe('17/20');
    expect(note).toBeNull();
  });

  it('NoPointsPossible_Untouched: no scale to enforce', () => {
    const o = output('17/20');
    const note = enforceAssignmentScale(o, [], null);
    expect(o.TotalPoints).toBe('17/20');
    expect(note).toBeNull();
  });

  it('NoDenominator_Untouched: a bare number has no scale to correct', () => {
    const o = output('17');
    const note = enforceAssignmentScale(o, [], 5);
    expect(o.TotalPoints).toBe('17');
    expect(note).toBeNull();
  });
});
