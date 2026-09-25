// Pure state helpers for the Rubrics tab's editor (no React) — the load →
// edit → save mapping and its validation, extracted so the id round-trip
// discipline is unit-testable.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Pages\
// OutcomesAlignment.razor (@code — CriterionEdit/RatingEdit, StartRubricEdit,
// AddCriterion/AddRating defaults, SaveRubricAsync validation + criteria
// mapping). RUBRIC ID RULE (parity contract pinned by @aigrader/canvas tests):
// Canvas criterion/rating ids are EXACT raw strings end-to-end — never parsed
// or reformatted; '' marks a NEW row whose id the update form omits so Canvas
// mints a fresh one.

// ------------------------------------------------------------------- types --

/** One rubric rating as the engine serves it (Canvas raw-string ids). */
export type RubricRatingDto = {
  id: string;
  description?: string | null;
  long_description?: string | null;
  points: number;
};

/** One rubric criterion as the engine serves it. */
export type RubricCriterionDto = {
  id: string;
  description?: string | null;
  long_description?: string | null;
  points: number;
  learning_outcome_id?: string | number | null;
  ratings?: RubricRatingDto[] | null;
};

/** The engine's /course/rubric/get payload (port of C# AssignmentRubric). */
export type RubricDto = {
  hasRubric: boolean;
  rubricId: number;
  title: string;
  criteria: RubricCriterionDto[];
  rubricAssociationId: number | null;
  otherAssignmentCount: number;
  shared: boolean;
  sharedUnknown: boolean;
};

/** Editable rating row; same exact-id rule as CriterionEdit. */
export type RatingEdit = {
  id: string;
  description: string;
  /** Carried through unedited (the C# editor did not expose it). */
  longDescription: string | null;
  points: number;
};

/** Editable rubric criterion. `id` holds Canvas's EXACT id string and is
 * never parsed or regenerated; '' marks a new row. */
export type CriterionEdit = {
  id: string;
  description: string;
  longDescription: string;
  points: number;
  /** Select-friendly outcome id; '' = not linked. */
  outcomeId: string;
  ratings: RatingEdit[];
};

/** The JSON criterion row the update endpoint passes through to Canvas. */
export type CriterionUpdateRow = {
  id: string;
  description: string;
  long_description: string | null;
  points: number;
  learning_outcome_id: string | null;
  ratings: Array<{
    id: string;
    description: string;
    long_description: string | null;
    points: number;
  }>;
};

// ------------------------------------------------------------ display text --

/** Tag-strip + basic entity decode for DISPLAY only (edit fields bind the raw
 * value so saves never mangle Canvas's stored HTML). Mirrors the C# page's
 * HtmlTextExtractor.StripHtml usage on long descriptions. */
export function stripHtmlText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// -------------------------------------------------------------- edit state --

/** Builds the edit form from a freshly loaded rubric (port of the C#
 * StartRubricEditAsync mapping) — ids copied EXACTLY as received. */
export function toEditState(rubric: RubricDto): { title: string; criteria: CriterionEdit[] } {
  return {
    title: rubric.title,
    criteria: rubric.criteria.map((c) => ({
      id: c.id, // EXACT Canvas id — never reformat (round-trip rule)
      description: c.description ?? '',
      longDescription: c.long_description ?? '',
      points: c.points,
      outcomeId: c.learning_outcome_id == null ? '' : String(c.learning_outcome_id),
      ratings: (c.ratings ?? []).map((r) => ({
        id: r.id,
        description: r.description ?? '',
        longDescription: r.long_description ?? null,
        points: r.points,
      })),
    })),
  };
}

/** A new criterion row — no id: Canvas mints one on save (the C#
 * AddCriterion defaults, themselves the TS editor's default rows). */
export function newCriterion(): CriterionEdit {
  return {
    id: '',
    description: 'New criterion',
    longDescription: '',
    points: 5,
    outcomeId: '',
    ratings: [
      { id: '', description: 'Full Marks', longDescription: null, points: 5 },
      { id: '', description: 'No Marks', longDescription: null, points: 0 },
    ],
  };
}

/** A new rating row (the C# AddRating defaults). */
export function newRating(): RatingEdit {
  return { id: '', description: 'New rating', longDescription: null, points: 0 };
}

/** The C# SaveRubricAsync pre-save checks; null = valid. */
export function validateRubricEdit(criteria: CriterionEdit[]): string | null {
  if (criteria.length === 0) return 'A rubric needs at least one criterion.';
  if (criteria.some((c) => c.ratings.length === 0)) {
    return 'Every criterion needs at least one rating level.';
  }
  return null;
}

/** Maps edit rows onto the update endpoint's criterion rows. Ids pass through
 * EXACTLY as loaded ('' marks new rows — the canvas form builder omits their
 * id keys); '' outcome selections become null (not linked). */
export function toUpdateCriteria(criteria: CriterionEdit[]): CriterionUpdateRow[] {
  return criteria.map((c) => ({
    id: c.id,
    description: c.description,
    long_description: c.longDescription === '' ? null : c.longDescription,
    points: c.points,
    learning_outcome_id: c.outcomeId === '' ? null : c.outcomeId,
    ratings: c.ratings.map((r) => ({
      id: r.id,
      description: r.description,
      long_description: r.longDescription,
      points: r.points,
    })),
  }));
}

/** The shared-rubric warning line, or null when editing is safe. `shared`
 * mirrors the C# banner text; `sharedUnknown` covers the port's fallback
 * path where Canvas's associations lookup failed. */
export function sharedWarning(rubric: RubricDto): string | null {
  if (rubric.shared) {
    const n = rubric.otherAssignmentCount;
    return (
      `This rubric is also used by ${n} other assignment${n === 1 ? '' : 's'} — ` +
      `saving changes it for ${n === 1 ? 'it' : 'them'} too.`
    );
  }
  if (rubric.sharedUnknown) {
    return (
      'Canvas did not say whether other assignments share this rubric — ' +
      'saving may change it for them too.'
    );
  }
  return null;
}
