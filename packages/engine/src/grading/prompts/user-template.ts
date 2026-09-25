// Ported from: C:\Devs\AIgrader\lib\agents\grader\user-template.ts
// Cross-checked against: C:\Devs\AIGrader-C#\src\AiGrader\Services\Ai\Prompts\GraderPrompts.cs
// (BuildUserMessage — the pinned spec; layout and prose byte-identical).
//
// Grader user-message template — preserved VERBATIM from the n8n MVP's
// `AI Agent` node `text` field. The expression substitutions are replaced with
// parameters, but the prose around them is unchanged. Faculty calibration
// depends on this exact phrasing; golden tests pin the bytes.

export type BuildUserMessageArgs = {
  courseSettingsText: string;
  cleanedAssignmentText: string;
  /**
   * The rubric snapshot's criteria EXACTLY as Canvas returned them (raw JSON
   * objects with snake_case wire names and untouched id forms), or null when
   * the assignment has no rubric. Serialized with JSON.stringify so the
   * prompt embeds the raw wire form — never re-shape or coerce ids here
   * (byte-parity + the Canvas silent-drop rule).
   */
  rubric: readonly unknown[] | null;
  studentSubmissionText: string;
  additionalInstructions: string | null;
  // Optional per-assignment grading materials. When all are absent the
  // returned message is byte-identical to the verbatim n8n template; when
  // present, a clearly-delimited supplemental block is appended so the
  // calibrated core layout is never disturbed.
  providedTemplateText?: string | null;
  gradingKeyText?: string | null;
  excelKeyComparison?: string | null;
  /**
   * The assignment's max points; drives the scoring-scale block when no
   * rubric is in the prompt (see SCORING_SCALE_FORMAT).
   */
  pointsPossible?: number | null;
};

/**
 * The scoring-scale block, appended when the prompt carries NO rubric.
 * Without it the model has no idea what the assignment is out of and invents
 * a scale (the field bug: "17/20" drafts on a 5-point assignment). When a
 * rubric IS in the prompt it defines the scale and this block is omitted —
 * "use only rubric-valid point values" stays the one authority.
 * Ported from: GraderPrompts.cs ScoringScaleFormat ({0} = points-possible).
 */
export function scoringScaleBlock(pointsPossible: number): string {
  const p = formatPoints(pointsPossible);
  return `SCORING SCALE\nThis assignment is worth ${p} points. No rubric is provided, so grade the submission holistically against the assignment context and award between 0 and ${p} points. TotalPoints must use ${p} as its denominator (for example "3.5/${p}").`;
}

/** C# "0.##" invariant formatting: up to 2 decimals, trailing zeros trimmed. */
export function formatPoints(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function buildUserMessage(args: BuildUserMessageArgs): string {
  const rubricBlock =
    args.rubric && args.rubric.length > 0
      ? JSON.stringify(args.rubric)
      : JSON.stringify({ Rubric: 'None available, please use assignment context.' });

  // Empty strings are preserved exactly as the n8n template does — the
  // section headers stay even when their contents are blank, because the
  // model's calibration was trained on that layout.
  const core = `Evaluate this Canvas assignment submission.

COURSE GRADING PROFILE
${args.courseSettingsText}

ASSIGNMENT CONTEXT
${args.cleanedAssignmentText}

ASSIGNMENT RUBRIC
${rubricBlock}

STUDENT SUBMISSION
${args.studentSubmissionText}

INSTRUCTOR STYLE NOTES
${args.additionalInstructions ?? ''}

Scoring instructions:
1. Review the assignment requirements and rubric carefully.
2. Evaluate each rubric criterion separately.
3. For each criterion:
   - choose the closest matching rubric level
   - assign the corresponding valid score
   - explain the reason briefly
   - cite short supporting evidence from the submission
4. Then write a short overall feedback summary.

Additional behavior:
- If the course profile has missing fields, continue grading using the rubric and assignment instructions.
`;

  // The scale statement: only when the model would otherwise grade blind
  // (no rubric in the prompt) and the assignment's point value is known.
  // Appended AFTER the core, before supplemental — C# BuildUserMessage order.
  const hasRubric = !!args.rubric && args.rubric.length > 0;
  const scale =
    hasRubric || !(args.pointsPossible != null && args.pointsPossible > 0)
      ? ''
      : scoringScaleBlock(args.pointsPossible) + '\n';

  const supplemental = buildSupplementalBlock(args);

  let message = core;
  if (scale.length > 0) message += `\n${scale}`;
  if (supplemental.length > 0) message += `\n${supplemental}`;
  return message;
}

// Appended only when per-assignment materials exist. Kept out of the verbatim
// core so existing grading behavior is unchanged.
function buildSupplementalBlock(args: BuildUserMessageArgs): string {
  const template = args.providedTemplateText?.trim();
  const key = args.gradingKeyText?.trim();
  const excel = args.excelKeyComparison?.trim();
  if (!template && !key && !excel) return '';

  const parts: string[] = ['SUPPLEMENTAL GRADING MATERIALS'];
  if (template) {
    parts.push(
      `PROVIDED TEMPLATE (the starter file given to students — do not award credit for unchanged boilerplate; assess the student's own additions and changes):\n${template}`,
    );
  }
  if (key) {
    parts.push(`GRADING KEY / REFERENCE ANSWER:\n${key}`);
  }
  if (excel) {
    parts.push(
      `AUTOMATED ANSWER CHECK (deterministic comparison of the student's spreadsheet against the grading key — treat as authoritative for cell-level correctness):\n${excel}`,
    );
  }
  return parts.join('\n\n') + '\n';
}
