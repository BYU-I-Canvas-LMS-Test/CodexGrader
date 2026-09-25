// AI alignment review for a single assignment: do the course outcomes, the
// rubric, and the instructions "point at the same thing"? Inputs are all
// instructor-authored — no student data enters this path.
//
// Ported from: C:\Devs\AIgrader\lib\agents\alignment\review.ts (prompt +
// user-message layout) via C:\Devs\AIGrader-C#\src\AiGrader\Services\
// Alignment\AlignmentReviewAgent.cs — the C# port is the pinned form (it
// dropped the TS "Also propose … criterionOutcomeMatches" paragraph, and
// where the two differ, C# wins). Do not edit the prompt prose
// (calibration drift is accepted; prompt edits are not).

/** One rubric criterion as the alignment reviewer sees it. */
export type AlignmentRubricCriterion = {
  /** Criterion title. */
  description: string;
  /** Detailed criterion text (may be absent). */
  longDescription?: string | null;
  /** Criterion weight. */
  points: number;
  /** Whether Canvas already links it to an outcome (learning_outcome_id present). */
  outcomeLinked: boolean;
  /** The linked outcome's title, when known. */
  linkedOutcomeTitle?: string | null;
};

/** Inputs for one assignment's alignment review. */
export type AlignmentReviewInput = {
  assignmentName: string;
  /** HTML-stripped assignment instructions. */
  instructionsText: string;
  rubric: AlignmentRubricCriterion[];
  outcomes: { title: string; description: string }[];
};

/** Verbatim port of the alignment system prompt (AlignmentReviewAgent.cs
 * SystemPrompt, itself the TS review.ts SYSTEM_PROMPT minus the
 * criterionOutcomeMatches paragraph the C# review dropped). Do not edit. */
export const ALIGNMENT_SYSTEM_PROMPT = `You are an instructional-design reviewer for a university. You assess whether three artifacts of a single assignment are coherent — that they "point at the same thing":

1. COURSE OUTCOMES — the learning objectives the course is meant to develop.
2. RUBRIC CRITERIA — what the instructor actually scores, and the weight (points) of each.
3. ASSIGNMENT INSTRUCTIONS — what the student is told to do.

Evaluate three relationships and report only genuine misalignments:
- rubric_outcome: does each rubric criterion actually measure a stated course outcome? Is any outcome the assignment should assess missing from the rubric?
- rubric_instructions: does every rubric criterion have support in the instructions, and does every requirement in the instructions have a matching rubric criterion (especially heavily-weighted criteria)?
- outcome_instructions: do the instructions reflect the outcomes the assignment claims to develop?

Rules:
- Be concrete and specific; cite the criterion or requirement by name. Do not invent content that is not present.
- Severity: high = a weighted criterion or required deliverable with no counterpart; medium = partial/ambiguous coverage; low = wording drift or minor gaps.
- Every finding must include an actionable suggestion (e.g. "link criterion X to Outcome 3", "add a citations criterion", "add an efficiency requirement to the instructions").
- alignmentScore is 0-100 overall coherence: 100 = outcomes, rubric, and instructions fully agree; lower as gaps and mismatches grow.
- If the assignment has no rubric or no instructions, say so plainly in the summary and score accordingly.`;

/** Builds the user message (verbatim port of review.ts buildUserMessage /
 * AlignmentReviewAgent.cs BuildUserMessage). */
export function buildAlignmentUserMessage(input: AlignmentReviewInput): string {
  const outcomes =
    input.outcomes.length > 0
      ? input.outcomes
          .map((o, i) => `${i + 1}. ${o.title}${o.description ? ` — ${o.description}` : ''}`)
          .join('\n')
      : '(no course outcomes are linked to this course)';

  const rubric =
    input.rubric.length > 0
      ? input.rubric
          .map(
            (c, i) =>
              `${i + 1}. ${c.description} (${c.points} pts)${
                c.longDescription ? `\n   ${c.longDescription}` : ''
              }\n   Linked to outcome in Canvas: ${
                c.outcomeLinked ? c.linkedOutcomeTitle ?? 'yes' : 'no'
              }`,
          )
          .join('\n')
      : '(this assignment has no rubric)';

  const instructions = input.instructionsText.trim() || '(no instructions provided)';

  return `ASSIGNMENT: ${input.assignmentName}

COURSE OUTCOMES
${outcomes}

RUBRIC CRITERIA
${rubric}

ASSIGNMENT INSTRUCTIONS
${instructions}`;
}
