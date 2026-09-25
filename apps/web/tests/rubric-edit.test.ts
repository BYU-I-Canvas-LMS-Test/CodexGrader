// Rubric editor state helpers (outcomes page, Rubrics tab): the load → edit →
// save mapping and its validation. The load-bearing contract is the RUBRIC ID
// RULE — Canvas criterion/rating ids ride as EXACT raw strings end-to-end and
// '' marks NEW rows — plus the C# editor's defaults and pre-save checks.

import { describe, expect, it } from 'vitest';
import {
  newCriterion,
  newRating,
  sharedWarning,
  stripHtmlText,
  toEditState,
  toUpdateCriteria,
  validateRubricEdit,
  type RubricDto,
} from '../app/courses/[courseKey]/outcomes/rubric-edit';

const RUBRIC: RubricDto = {
  hasRubric: true,
  rubricId: 88,
  title: 'Essay Rubric',
  criteria: [
    {
      id: '_4692', // Canvas's underscore-prefixed form — must survive verbatim
      description: 'Thesis',
      long_description: '<p>Clear&nbsp;thesis</p>',
      points: 5,
      learning_outcome_id: 7, // numeric from Canvas → select-friendly string
      ratings: [
        { id: 'blank', description: 'Full Marks', long_description: null, points: 5 },
        { id: 'blank_2', description: 'No Marks', long_description: 'none', points: 0 },
      ],
    },
    {
      id: '170', // numeric-string form
      description: null,
      long_description: null,
      points: 10,
      learning_outcome_id: null,
      ratings: null,
    },
  ],
  rubricAssociationId: 12,
  otherAssignmentCount: 0,
  shared: false,
  sharedUnknown: false,
};

describe('toEditState', () => {
  it('copies ids EXACTLY and maps outcome links to select-friendly strings', () => {
    const state = toEditState(RUBRIC);
    expect(state.title).toBe('Essay Rubric');
    expect(state.criteria.map((c) => c.id)).toEqual(['_4692', '170']);
    expect(state.criteria[0]!.outcomeId).toBe('7');
    expect(state.criteria[1]!.outcomeId).toBe(''); // not linked
    expect(state.criteria[0]!.ratings.map((r) => r.id)).toEqual(['blank', 'blank_2']);
    // Edit fields bind RAW values — display-only stripping happens elsewhere.
    expect(state.criteria[0]!.longDescription).toBe('<p>Clear&nbsp;thesis</p>');
    // Rating long descriptions carry through unedited (not exposed in the form).
    expect(state.criteria[0]!.ratings[1]!.longDescription).toBe('none');
    // Null-safe defaults for sparse Canvas rows.
    expect(state.criteria[1]!).toMatchObject({ description: '', longDescription: '', ratings: [] });
  });
});

describe('toUpdateCriteria', () => {
  it('round-trips ids untouched and keeps "" as the new-row marker', () => {
    const state = toEditState(RUBRIC);
    state.criteria.push(newCriterion());
    const rows = toUpdateCriteria(state.criteria);
    expect(rows.map((r) => r.id)).toEqual(['_4692', '170', '']);
    expect(rows[2]!.ratings.map((r) => r.id)).toEqual(['', '']);
    expect(rows[0]!.ratings.map((r) => r.id)).toEqual(['blank', 'blank_2']);
  });

  it('maps outcome selections: "" → null (not linked), otherwise the raw string', () => {
    const rows = toUpdateCriteria(toEditState(RUBRIC).criteria);
    expect(rows[0]!.learning_outcome_id).toBe('7');
    expect(rows[1]!.learning_outcome_id).toBeNull();
  });

  it('nulls empty long descriptions and preserves rating long descriptions', () => {
    const rows = toUpdateCriteria(toEditState(RUBRIC).criteria);
    expect(rows[0]!.long_description).toBe('<p>Clear&nbsp;thesis</p>');
    expect(rows[1]!.long_description).toBeNull();
    expect(rows[0]!.ratings[1]!.long_description).toBe('none');
  });
});

describe('editor defaults (C# AddCriterion / AddRating parity)', () => {
  it('new criterion: no id, "New criterion", 5 pts, Full Marks 5 / No Marks 0', () => {
    expect(newCriterion()).toEqual({
      id: '',
      description: 'New criterion',
      longDescription: '',
      points: 5,
      outcomeId: '',
      ratings: [
        { id: '', description: 'Full Marks', longDescription: null, points: 5 },
        { id: '', description: 'No Marks', longDescription: null, points: 0 },
      ],
    });
  });

  it('new rating: no id, "New rating", 0 pts', () => {
    expect(newRating()).toEqual({ id: '', description: 'New rating', longDescription: null, points: 0 });
  });
});

describe('validateRubricEdit (C# SaveRubricAsync pre-save checks)', () => {
  it('requires at least one criterion', () => {
    expect(validateRubricEdit([])).toBe('A rubric needs at least one criterion.');
  });

  it('requires at least one rating per criterion', () => {
    const crit = { ...newCriterion(), ratings: [] };
    expect(validateRubricEdit([crit])).toBe('Every criterion needs at least one rating level.');
  });

  it('passes a well-formed edit', () => {
    expect(validateRubricEdit([newCriterion()])).toBeNull();
  });
});

describe('sharedWarning', () => {
  it('warns with the other-assignment count (singular/plural, C# banner text)', () => {
    expect(sharedWarning({ ...RUBRIC, shared: true, otherAssignmentCount: 1 })).toBe(
      'This rubric is also used by 1 other assignment — saving changes it for it too.',
    );
    expect(sharedWarning({ ...RUBRIC, shared: true, otherAssignmentCount: 3 })).toBe(
      'This rubric is also used by 3 other assignments — saving changes it for them too.',
    );
  });

  it('warns when sharing could not be determined (associations lookup failed)', () => {
    expect(sharedWarning({ ...RUBRIC, sharedUnknown: true })).toContain(
      'did not say whether other assignments share this rubric',
    );
  });

  it('stays quiet for an unshared rubric', () => {
    expect(sharedWarning(RUBRIC)).toBeNull();
  });
});

describe('stripHtmlText (display only)', () => {
  it('strips tags, decodes basic entities, collapses whitespace', () => {
    expect(stripHtmlText('<p>Clear&nbsp;thesis</p>')).toBe('Clear thesis');
    expect(stripHtmlText('<b>a</b> &amp; <i>b</i>')).toBe('a & b');
    expect(stripHtmlText(null)).toBe('');
    expect(stripHtmlText(undefined)).toBe('');
  });
});
