// Pins the form-encoded parameter shape of the rubric update PUT
// (buildRubricUpdateForm). The load-bearing rule: criterion and rating ids
// round-trip EXACTLY as received (mixed "_4692" vs numeric-string forms) —
// Canvas silently drops rubric data keyed in the wrong form — and new rows
// (empty id) omit the id key so Canvas mints one.
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\RubricUpdateFormTests.cs

import { describe, expect, it } from 'vitest';
import { buildRubricUpdateForm } from '../src/client.js';
import type { RubricCriterionInput } from '../src/client.js';

/** A realistic mixed-id rubric: an old-style "_4692" criterion, a new-style
 * numeric-string criterion, and a freshly added row with no id. */
function mixedIdFixture(): RubricCriterionInput[] {
  return [
    {
      id: '_4692',
      description: 'Thesis',
      long_description: 'States a clear, arguable thesis.',
      points: 20,
      learning_outcome_id: 321,
      ratings: [
        { id: '_4692_7891', description: 'Full Marks', points: 20 },
        { id: 'blank_2', description: 'No Marks', points: 0 },
      ],
    },
    {
      id: '1745118159974',
      description: 'Evidence',
      long_description: null, // never edited — key must be omitted
      points: 5.5,
      learning_outcome_id: null,
      ratings: [{ id: '1745118159975', description: 'Pass', points: 5.5 }],
    },
    {
      id: '', // newly added in the editor — id key must be omitted
      description: 'New criterion',
      points: 5,
      ratings: [
        { id: '', description: 'Full Marks', points: 5 },
        { id: '', description: 'No Marks', points: 0 },
      ],
    },
  ];
}

describe('buildRubricUpdateForm', () => {
  it('round-trips mixed ids exactly and omits id keys for new rows', () => {
    const form = buildRubricUpdateForm('Essay Rubric', mixedIdFixture(), 9001);
    const dict = Object.fromEntries(form);

    expect(dict['rubric[criteria][0][id]']).toBe('_4692');
    expect(dict['rubric[criteria][0][ratings][0][id]']).toBe('_4692_7891');
    expect(dict['rubric[criteria][0][ratings][1][id]']).toBe('blank_2');
    expect(dict['rubric[criteria][1][id]']).toBe('1745118159974');
    expect(dict['rubric[criteria][1][ratings][0][id]']).toBe('1745118159975');

    // The new criterion and its ratings must carry NO id keys at all.
    expect(form.some(([k]) => k === 'rubric[criteria][2][id]')).toBe(false);
    expect(
      form.some(([k]) => k.startsWith('rubric[criteria][2][ratings]') && k.endsWith('[id]')),
    ).toBe(false);
  });

  it('builds the exact Canvas param shape: title first, association id last, optionals only when set', () => {
    const form = buildRubricUpdateForm('Essay Rubric', mixedIdFixture(), 9001);
    const dict = Object.fromEntries(form);

    expect(form[0]).toEqual(['rubric[title]', 'Essay Rubric']);
    expect(form[form.length - 1]).toEqual(['rubric_association_id', '9001']);

    expect(dict['rubric[criteria][0][description]']).toBe('Thesis');
    expect(dict['rubric[criteria][0][long_description]']).toBe('States a clear, arguable thesis.');
    expect(dict['rubric[criteria][0][points]']).toBe('20');
    expect(dict['rubric[criteria][0][learning_outcome_id]']).toBe('321');
    expect(dict['rubric[criteria][0][ratings][0][description]']).toBe('Full Marks');
    expect(dict['rubric[criteria][0][ratings][1][points]']).toBe('0');

    // Fractional points serialize with a decimal point (invariant form).
    expect(dict['rubric[criteria][1][points]']).toBe('5.5');
    expect(dict['rubric[criteria][1][ratings][0][points]']).toBe('5.5');

    // Unset optionals are OMITTED, not sent empty.
    expect(form.some(([k]) => k === 'rubric[criteria][1][long_description]')).toBe(false);
    expect(form.some(([k]) => k === 'rubric[criteria][1][learning_outcome_id]')).toBe(false);
  });

  it('omits the rubric_association_id key when unknown', () => {
    const form = buildRubricUpdateForm('Essay Rubric', mixedIdFixture(), null);
    expect(form.some(([k]) => k === 'rubric_association_id')).toBe(false);
  });
});
