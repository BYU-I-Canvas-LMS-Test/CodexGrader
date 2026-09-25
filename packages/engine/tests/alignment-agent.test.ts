// Alignment review agent: the system prompt is BYTE-PINNED (verbatim lift of
// AlignmentReviewAgent.cs SystemPrompt — prompt edits are a parity break), the
// user-message layout is golden-tested against the C# BuildUserMessage form,
// the zod output schema is the validation gate (incl. the lenient severity
// shape), and StructuredGradingClient.reviewAlignment is exercised through
// an injected modelCall (MODEL CALLS ARE NEVER MADE IN TESTS).

import { describe, expect, it } from 'vitest';
import {
  AlignmentFindingSchema,
  AssignmentAlignmentSchema,
  buildAlignmentResponseSchema,
} from '../src/llm/alignment-schemas.js';
import {
  ALIGNMENT_SYSTEM_PROMPT,
  buildAlignmentUserMessage,
} from '../src/alignment/review-agent.js';
import {
  StructuredGradingClient,
  GradingCallError,
  type ModelRequest,
  type ModelResponse,
} from '../src/llm/structured-client.js';

// ------------------------------------------------------------- prompt pin --

/** Verbatim expectation — AlignmentReviewAgent.cs SystemPrompt (which is the
 * TS review.ts SYSTEM_PROMPT minus the criterionOutcomeMatches paragraph the
 * C# review dropped; where the two differ, C# wins). */
const PINNED_SYSTEM_PROMPT = `You are an instructional-design reviewer for a university. You assess whether three artifacts of a single assignment are coherent — that they "point at the same thing":

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

describe('ALIGNMENT_SYSTEM_PROMPT', () => {
  it('is byte-identical to the pinned C# SystemPrompt', () => {
    expect(ALIGNMENT_SYSTEM_PROMPT).toBe(PINNED_SYSTEM_PROMPT);
  });

  it('does NOT carry the TS criterionOutcomeMatches paragraph (C# wins)', () => {
    expect(ALIGNMENT_SYSTEM_PROMPT).not.toContain('Also propose');
    expect(ALIGNMENT_SYSTEM_PROMPT).not.toContain('confidence band');
  });
});

// ------------------------------------------------------- user message form --

describe('buildAlignmentUserMessage', () => {
  it('lays out outcomes, rubric, and instructions exactly like the C# builder', () => {
    const message = buildAlignmentUserMessage({
      assignmentName: 'Essay 1',
      instructionsText: 'Write an essay.\nCite three sources.',
      rubric: [
        {
          description: 'Thesis',
          longDescription: 'States a clear thesis',
          points: 10,
          outcomeLinked: true,
          linkedOutcomeTitle: 'Think critically',
        },
        {
          description: 'Citations',
          points: 5,
          outcomeLinked: false,
        },
      ],
      outcomes: [
        { title: 'Think critically', description: 'Analyze arguments' },
        { title: 'Write clearly', description: '' },
      ],
    });

    expect(message).toBe(`ASSIGNMENT: Essay 1

COURSE OUTCOMES
1. Think critically — Analyze arguments
2. Write clearly

RUBRIC CRITERIA
1. Thesis (10 pts)
   States a clear thesis
   Linked to outcome in Canvas: Think critically
2. Citations (5 pts)
   Linked to outcome in Canvas: no

ASSIGNMENT INSTRUCTIONS
Write an essay.
Cite three sources.`);
  });

  it('uses the exact empty-state placeholders', () => {
    const message = buildAlignmentUserMessage({
      assignmentName: 'Bare',
      instructionsText: '   ',
      rubric: [],
      outcomes: [],
    });
    expect(message).toContain('(no course outcomes are linked to this course)');
    expect(message).toContain('(this assignment has no rubric)');
    expect(message).toContain('(no instructions provided)');
  });

  it('linked criterion without a known title falls back to "yes"', () => {
    const message = buildAlignmentUserMessage({
      assignmentName: 'A',
      instructionsText: 'x',
      rubric: [{ description: 'C1', points: 3, outcomeLinked: true, linkedOutcomeTitle: null }],
      outcomes: [],
    });
    expect(message).toContain('Linked to outcome in Canvas: yes');
  });
});

// ------------------------------------------------------------- zod schema --

describe('AssignmentAlignmentSchema', () => {
  const finding = {
    severity: 'high',
    pairing: 'rubric_outcome',
    title: 'Gap',
    detail: 'The rubric grades X but no outcome mentions it.',
    suggestion: 'Link criterion X to Outcome 2.',
  };

  it('accepts a valid review', () => {
    const parsed = AssignmentAlignmentSchema.parse({
      alignmentScore: 72,
      summary: 'Mostly aligned.',
      findings: [finding],
    });
    expect(parsed.findings[0]!.severity).toBe('high');
  });

  it('accepts the lenient { level } severity shape (model drift)', () => {
    const parsed = AlignmentFindingSchema.parse({
      ...finding,
      severity: { level: 'medium', note: 'drifted shape' },
    });
    expect(parsed.severity).toBe('medium');
  });

  it('rejects unknown pairings, out-of-range scores, and empty suggestions', () => {
    expect(
      AlignmentFindingSchema.safeParse({ ...finding, pairing: 'rubric_vibes' }).success,
    ).toBe(false);
    expect(
      AssignmentAlignmentSchema.safeParse({ alignmentScore: 101, summary: 's', findings: [] })
        .success,
    ).toBe(false);
    expect(AlignmentFindingSchema.safeParse({ ...finding, suggestion: '' }).success).toBe(false);
  });
});

describe('buildAlignmentResponseSchema', () => {
  it('pins the required fields and the severity/pairing enums', () => {
    const schema = buildAlignmentResponseSchema() as unknown as {
      required: string[];
      properties: {
        findings: { items: { required: string[]; properties: Record<string, { enum?: string[] }> } };
      };
    };
    expect(schema.required).toEqual(['alignmentScore', 'summary', 'findings']);
    expect(schema.properties.findings.items.required).toEqual([
      'severity',
      'pairing',
      'title',
      'detail',
      'suggestion',
    ]);
    expect(schema.properties.findings.items.properties.severity!.enum).toEqual([
      'high',
      'medium',
      'low',
    ]);
    expect(schema.properties.findings.items.properties.pairing!.enum).toEqual([
      'rubric_outcome',
      'rubric_instructions',
      'outcome_instructions',
    ]);
  });
});

// --------------------------------------------- LLM-client reviewAlignment --

function textResponse(payload: unknown): ModelResponse {
  return {
    text: JSON.stringify(payload),
    usage: { inputTokens: 100, outputTokens: 40 },
  };
}

const validReview = {
  alignmentScore: 88,
  summary: 'Coherent overall.',
  findings: [
    {
      severity: 'low',
      pairing: 'rubric_instructions',
      title: 'Wording drift',
      detail: 'The rubric says report; the instructions say essay.',
      suggestion: 'Align the terminology.',
    },
  ],
};

describe('StructuredGradingClient.reviewAlignment', () => {
  it('sends the strict alignment schema + system prompt and validates the output', async () => {
    const calls: ModelRequest[] = [];
    const client = new StructuredGradingClient({
      modelCall: async (request) => {
        calls.push(request);
        return textResponse(validReview);
      },
    });

    const result = await client.reviewAlignment({
      systemPrompt: ALIGNMENT_SYSTEM_PROMPT,
      userMessage: 'ASSIGNMENT: X',
      model: 'test-model',
      reasoningEffort: 'low',
    });

    expect(result.output.alignmentScore).toBe(88);
    expect(result.output.findings).toHaveLength(1);
    expect(result.stats).toMatchObject({
      model: 'test-model',
      promptTokens: 100,
      outputTokens: 40,
    });

    const request = calls[0]!;
    expect(request.systemPrompt).toBe(ALIGNMENT_SYSTEM_PROMPT);
    expect(request.reasoningEffort).toBe('low');
    expect(request.images).toEqual([]);
    expect(request.responseSchema.required).toEqual(['alignmentScore', 'summary', 'findings']);
    expect(request.responseSchema.additionalProperties).toBe(false);
  });

  it('repairs ONE validation failure by appending the error, then succeeds', async () => {
    const userTexts: string[] = [];
    let call = 0;
    const client = new StructuredGradingClient({
      modelCall: async (request) => {
        userTexts.push(request.userText);
        call += 1;
        return call === 1
          ? textResponse({ ...validReview, findings: [{ severity: 'high' }] }) // invalid finding
          : textResponse(validReview);
      },
    });

    const result = await client.reviewAlignment({
      systemPrompt: 'sys',
      userMessage: 'original message',
      model: 'test-model',
    });

    expect(result.output.alignmentScore).toBe(88);
    expect(userTexts).toHaveLength(2);
    expect(userTexts[1]).toContain('original message');
    expect(userTexts[1]).toContain('Your previous response was rejected');
  });

  it('declares the failure deterministic when the repair also fails', async () => {
    const client = new StructuredGradingClient({
      modelCall: async () => textResponse({ nope: true }),
    });

    await expect(
      client.reviewAlignment({ systemPrompt: 's', userMessage: 'u', model: 'm' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof GradingCallError && err.retryable === false,
    );
  });
});
