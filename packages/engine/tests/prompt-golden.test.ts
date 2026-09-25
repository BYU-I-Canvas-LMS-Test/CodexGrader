// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\PromptGoldenTests.cs
//
// PROMPT GOLDEN TESTS — the guardrail on the verbatim prompt port.
// The expected strings below are derived character-for-character from the
// TypeScript sources (lib\agents\grader\system-prompt.ts, user-template.ts),
// which themselves preserve the n8n MVP prompts faculty calibrated against,
// cross-checked against the C# GraderPrompts/QuizPrompts (the pinned spec).
// If one of these tests fails, the prompt drifted: fix the prompt, NOT the
// test, unless the change was a deliberate, signed-off recalibration.

import { describe, expect, it } from 'vitest';
import { parseCourseProfile, renderCourseProfileText } from '@aigrader/shared';
import {
  GRADER_MIXED_ID_CLAUSE,
  GRADER_SYSTEM_PROMPT,
  GRADER_VISION_CLAUSE,
  composeSystemPrompt,
} from '../src/grading/prompts/system-prompt.js';
import { buildUserMessage } from '../src/grading/prompts/user-template.js';
import {
  QUIZ_QUESTION_SYSTEM_PROMPT,
  buildQuizQuestionUserMessage,
} from '../src/grading/prompts/quiz-prompt.js';

describe('grader system prompt', () => {
  it('matches the golden bytes (SystemPromptMatchesGolden)', () => {
    const expected =
      'You are an academic grading assistant for Canvas.\n\n' +
      'Your job is to evaluate a student submission using:\n' +
      '1. the course grading profile,\n' +
      '2. the assignment instructions,\n' +
      '3. the assignment rubric,\n' +
      '4. the student submission,\n' +
      '5. any instructor-specific style instructions.\n\n' +
      'Before answering, analyze the work internally one rubric criterion at a time. Compare the student submission against the rubric language and the assignment requirements. Do not reveal your chain of thought or internal reasoning.\n\n' +
      'Rules:\n' +
      '- Base all judgments only on the provided materials.\n' +
      '- Do not invent missing content, student intent, or evidence.\n' +
      '- If evidence is missing, unclear, or incomplete, say so directly.\n' +
      '- Use only rubric-valid point values.\n' +
      '- Anchor comments in evidence from the submission whenever possible.\n' +
      '- Keep the overall feedback concise and useful.\n' +
      '- Keep each rubric feedback comment concise and specific.\n' +
      '- Be fair, accurate, and instructor-like rather than robotic.\n' +
      '- Apply any stylistic instructions only after scoring is complete.\n' +
      '- If stylistic instructions conflict with clarity or professionalism, prioritize clarity and professionalism.\n' +
      '- Return valid JSON only.';

    expect(GRADER_SYSTEM_PROMPT).toBe(expected);
  });

  it('pins the appendable clause bytes exactly', () => {
    expect(GRADER_VISION_CLAUSE).toBe(
      '\n\nVision input:\n' +
        '- You will be shown the student submission as page images. Read the visible text and any handwritten or diagrammatic content. Cite evidence using brief paraphrases since you cannot quote scanned handwriting verbatim.',
    );
    expect(GRADER_MIXED_ID_CLAUSE).toBe(
      '\n\nRubric ID format:\n' +
        '- Use the exact `id` and `ratingID` strings as provided in the rubric. Some IDs are numeric and some are strings beginning with an underscore — preserve type and value exactly.',
    );
  });

  it('appends clauses in fixed order (ClausesAppendInFixedOrder)', () => {
    const both = composeSystemPrompt({ vision: true, mixedRubricIds: true });

    expect(both.startsWith(GRADER_SYSTEM_PROMPT)).toBe(true);
    expect(both).toBe(GRADER_SYSTEM_PROMPT + GRADER_VISION_CLAUSE + GRADER_MIXED_ID_CLAUSE);
    const visionIdx = both.indexOf('Vision input:');
    const mixedIdx = both.indexOf('Rubric ID format:');
    expect(visionIdx).toBeGreaterThan(0);
    expect(mixedIdx).toBeGreaterThan(visionIdx);

    // Single-clause compositions.
    expect(composeSystemPrompt({ vision: true, mixedRubricIds: false })).toBe(
      GRADER_SYSTEM_PROMPT + GRADER_VISION_CLAUSE,
    );
    expect(composeSystemPrompt({ vision: false, mixedRubricIds: true })).toBe(
      GRADER_SYSTEM_PROMPT + GRADER_MIXED_ID_CLAUSE,
    );

    // No clauses → the verbatim prompt and nothing else.
    expect(composeSystemPrompt({ vision: false, mixedRubricIds: false })).toBe(
      GRADER_SYSTEM_PROMPT,
    );
  });
});

describe('grader user message', () => {
  it('matches the golden bytes with no rubric and no materials (UserMessageNoRubricMatchesGolden)', () => {
    const actual = buildUserMessage({
      courseSettingsText: 'PROFILE_TEXT',
      cleanedAssignmentText: 'ASSIGNMENT_TEXT',
      rubric: null,
      studentSubmissionText: 'SUBMISSION_TEXT',
      additionalInstructions: null,
    });

    const expected =
      'Evaluate this Canvas assignment submission.\n\n' +
      'COURSE GRADING PROFILE\nPROFILE_TEXT\n\n' +
      'ASSIGNMENT CONTEXT\nASSIGNMENT_TEXT\n\n' +
      'ASSIGNMENT RUBRIC\n{"Rubric":"None available, please use assignment context."}\n\n' +
      'STUDENT SUBMISSION\nSUBMISSION_TEXT\n\n' +
      'INSTRUCTOR STYLE NOTES\n\n\n' +
      'Scoring instructions:\n' +
      '1. Review the assignment requirements and rubric carefully.\n' +
      '2. Evaluate each rubric criterion separately.\n' +
      '3. For each criterion:\n' +
      '   - choose the closest matching rubric level\n' +
      '   - assign the corresponding valid score\n' +
      '   - explain the reason briefly\n' +
      '   - cite short supporting evidence from the submission\n' +
      '4. Then write a short overall feedback summary.\n\n' +
      'Additional behavior:\n' +
      '- If the course profile has missing fields, continue grading using the rubric and assignment instructions.\n';

    expect(actual).toBe(expected);
  });

  it('treats an empty rubric array like no rubric', () => {
    const withNull = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: null,
      studentSubmissionText: 's',
      additionalInstructions: null,
    });
    const withEmpty = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: [],
      studentSubmissionText: 's',
      additionalInstructions: null,
    });
    expect(withEmpty).toBe(withNull);
  });

  it('embeds the rubric as raw JSON with snake_case wire names and exact id forms (UserMessageEmbedsRubricJson)', () => {
    // The rubric snapshot arrives EXACTLY as Canvas sent it — snake_case
    // keys, mixed id forms — and must embed without any re-shaping.
    const rubric = [
      {
        id: '_4692',
        description: 'Thesis',
        long_description: null,
        points: 5,
        ratings: [{ id: '_817', description: 'Full', long_description: null, points: 5 }],
      },
    ];

    const message = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric,
      studentSubmissionText: 's',
      additionalInstructions: null,
    });

    expect(message).toContain('"id":"_4692"');
    expect(message).toContain('"long_description"'); // snake_case wire names survive
    expect(message).not.toContain('None available');
    // The full raw serialization lands verbatim in the ASSIGNMENT RUBRIC block.
    expect(message).toContain(`ASSIGNMENT RUBRIC\n${JSON.stringify(rubric)}\n\n`);
  });

  it('preserves numeric rubric ids as numbers in the embedded JSON', () => {
    // Canvas mixes numeric and string ids in the same rubric; the embedded
    // JSON must keep the numeric form unquoted (the silent-drop rule).
    const rubric = [
      { id: 4, description: 'Numeric', points: 2, ratings: [{ id: 1745118159974, points: 2 }] },
    ];
    const message = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric,
      studentSubmissionText: 's',
      additionalInstructions: null,
    });
    expect(message).toContain('"id":4');
    expect(message).toContain('"id":1745118159974');
  });

  it('appends materials AFTER the core; absent materials leave the core byte-identical (SupplementalBlockAppendsAfterCore)', () => {
    const without = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: null,
      studentSubmissionText: 's',
      additionalInstructions: null,
    });
    const withMaterials = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: null,
      studentSubmissionText: 's',
      additionalInstructions: null,
      providedTemplateText: 'TEMPLATE_CONTENT',
      gradingKeyText: 'KEY_CONTENT',
    });

    expect(withMaterials.startsWith(without)).toBe(true);
    expect(withMaterials).toContain('SUPPLEMENTAL GRADING MATERIALS');
    expect(withMaterials).toContain(
      'PROVIDED TEMPLATE (the starter file given to students — do not award credit for unchanged boilerplate; assess the student\'s own additions and changes):\nTEMPLATE_CONTENT',
    );
    expect(withMaterials).toContain('GRADING KEY / REFERENCE ANSWER:\nKEY_CONTENT');
    expect(withMaterials).not.toContain('AUTOMATED ANSWER CHECK'); // no excel comparison provided
  });

  it('includes the automated Excel check block when a comparison is provided', () => {
    const message = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: null,
      studentSubmissionText: 's',
      additionalInstructions: null,
      excelKeyComparison: 'CELL A1 matches; CELL B2 differs.',
    });
    expect(message).toContain(
      'AUTOMATED ANSWER CHECK (deterministic comparison of the student\'s spreadsheet against the grading key — treat as authoritative for cell-level correctness):\nCELL A1 matches; CELL B2 differs.',
    );
  });

  it('embeds renderCourseProfileText output verbatim in the COURSE GRADING PROFILE block', () => {
    // Composition-level golden: the shared profile renderer (its own goldens
    // live in packages/shared) must land byte-for-byte between the header and
    // the next section.
    const profileText = renderCourseProfileText(
      parseCourseProfile({
        courseProfile: { courseLevel: 'Intermediate', gradingPhilosophy: 'Reward clear reasoning.' },
        gradingDefaults: { strictness: 40 },
      }),
    );
    expect(profileText.length).toBeGreaterThan(0);

    const message = buildUserMessage({
      courseSettingsText: profileText,
      cleanedAssignmentText: 'ASSIGNMENT_TEXT',
      rubric: null,
      studentSubmissionText: 'SUBMISSION_TEXT',
      additionalInstructions: null,
    });

    expect(message).toContain(`COURSE GRADING PROFILE\n${profileText}\n\nASSIGNMENT CONTEXT`);
  });
});

describe('quiz prompts', () => {
  it('matches the quiz system prompt golden bytes (QuizSystemPromptMatchesGoldenAnchors, strengthened to full bytes)', () => {
    const expected =
      'You are an academic grading assistant for Canvas quiz questions.\n\n' +
      "Your job is to grade ONE student's answer to ONE quiz question using:\n" +
      '1. the course grading profile,\n' +
      '2. the question prompt,\n' +
      "3. the question's point value,\n" +
      '4. any author-provided grading guidance for the question,\n' +
      "5. the student's answer,\n" +
      '6. any instructor-specific style instructions.\n\n' +
      'Before answering, analyze the answer internally against the question prompt and the maximum point value. Do not reveal your chain of thought or internal reasoning.\n\n' +
      'Rules:\n' +
      '- Base all judgments only on the provided materials.\n' +
      '- Do not invent missing content, student intent, or evidence.\n' +
      '- If the answer is missing, unclear, or incomplete, say so directly and score accordingly.\n' +
      "- The score must be between 0 and the question's maximum point value, inclusive.\n" +
      "- Anchor your comment in evidence from the student's answer whenever possible.\n" +
      '- Keep the comment concise, specific, and useful to the student.\n' +
      '- Be fair, accurate, and instructor-like rather than robotic.\n' +
      '- Apply any stylistic instructions only after scoring is complete.\n' +
      '- If stylistic instructions conflict with clarity or professionalism, prioritize clarity and professionalism.\n' +
      '- Return valid JSON only.';

    expect(QUIZ_QUESTION_SYSTEM_PROMPT).toBe(expected);
    // The C# anchors, kept for cross-reference:
    expect(
      QUIZ_QUESTION_SYSTEM_PROMPT.startsWith(
        'You are an academic grading assistant for Canvas quiz questions.',
      ),
    ).toBe(true);
    expect(QUIZ_QUESTION_SYSTEM_PROMPT).toContain(
      "The score must be between 0 and the question's maximum point value, inclusive.",
    );
    expect(QUIZ_QUESTION_SYSTEM_PROMPT.endsWith('- Return valid JSON only.')).toBe(true);
  });

  it('assembles the quiz user message with stable headers, HTML-stripped question, and guidance folding (QuizUserMessageAssembles)', () => {
    const message = buildQuizQuestionUserMessage({
      courseProfileText: 'PROFILE',
      questionName: 'Q1',
      questionTextHtml: '<p>Explain <b>photosynthesis</b>.</p>',
      maxPoints: 10,
      correctComments: 'Mentions light + chlorophyll',
      neutralComments: null,
      studentAnswerText: 'ANSWER',
      additionalInstructions: null,
    });

    expect(message).toContain('QUESTION PROMPT\nExplain photosynthesis.');
    expect(message).toContain('MAXIMUM POINTS\n10');
    expect(message).toContain(
      'GRADING GUIDANCE\nWhat a correct answer looks like: Mentions light + chlorophyll',
    );
    expect(message).toContain('STUDENT ANSWER\nANSWER');

    // Full-byte pin of the assembled message (layout is a calibration surface).
    expect(message).toBe(
      'Grade this single quiz question answer.\n\n' +
        'COURSE GRADING PROFILE\nPROFILE\n\n' +
        'QUESTION NAME\nQ1\n\n' +
        'QUESTION PROMPT\nExplain photosynthesis.\n\n' +
        'MAXIMUM POINTS\n10\n\n' +
        'GRADING GUIDANCE\nWhat a correct answer looks like: Mentions light + chlorophyll\n\n' +
        'STUDENT ANSWER\nANSWER\n\n' +
        'INSTRUCTOR STYLE NOTES\n\n\n' +
        'Scoring instructions:\n' +
        '1. Read the question prompt and the maximum point value.\n' +
        "2. Evaluate the student's answer against the prompt and any grading guidance.\n" +
        '3. Assign a score between 0 and the maximum points (inclusive).\n' +
        '4. Write a concise comment explaining the score and citing brief evidence from the answer.\n',
    );
  });

  it('folds both guidance fields and keeps empty headers stable', () => {
    const both = buildQuizQuestionUserMessage({
      courseProfileText: '',
      questionName: 'Q2',
      questionTextHtml: 'Plain question?',
      maxPoints: 2.5,
      correctComments: ' Correct thing ',
      neutralComments: ' General note ',
      studentAnswerText: 'A',
      additionalInstructions: 'Be brief.',
    });
    expect(both).toContain(
      'GRADING GUIDANCE\nWhat a correct answer looks like: Correct thing\nGeneral notes: General note',
    );
    expect(both).toContain('MAXIMUM POINTS\n2.5');
    expect(both).toContain('INSTRUCTOR STYLE NOTES\nBe brief.');

    const none = buildQuizQuestionUserMessage({
      courseProfileText: '',
      questionName: 'Q3',
      questionTextHtml: '',
      maxPoints: 1,
      studentAnswerText: 'A',
    });
    // Headers render even when their contents are blank (empty line between).
    expect(none).toContain('GRADING GUIDANCE\n\n\nSTUDENT ANSWER');
    expect(none).toContain('COURSE GRADING PROFILE\n\n\nQUESTION NAME');
  });
});


describe('scoring-scale block (PromptGoldenTests port — the "17 out of 5" field bug)', () => {
  // No-rubric runs state the assignment's point value in a delimited block
  // AFTER the verbatim core; rubric runs never get the block — the rubric IS
  // the scale.
  it('ScoringScaleBlockAppendsForNoRubricRuns', () => {
    const without = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: null,
      studentSubmissionText: 's',
      additionalInstructions: null,
    });
    const withScale = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: null,
      studentSubmissionText: 's',
      additionalInstructions: null,
      pointsPossible: 5,
    });

    // The calibrated core stays byte-identical.
    expect(withScale.startsWith(without)).toBe(true);
    expect(withScale).toContain(
      'SCORING SCALE\nThis assignment is worth 5 points. ' +
        'No rubric is provided, so grade the submission holistically against the assignment context ' +
        'and award between 0 and 5 points. TotalPoints must use 5 as its denominator (for example "3.5/5").',
    );

    // A rubric in the prompt defines the scale — no block.
    const rubric = [{ id: '_1', points: 5 }];
    expect(
      buildUserMessage({
        courseSettingsText: 'p',
        cleanedAssignmentText: 'a',
        rubric,
        studentSubmissionText: 's',
        additionalInstructions: null,
        pointsPossible: 5,
      }),
    ).not.toContain('SCORING SCALE');

    // Unknown points-possible -> nothing to state.
    expect(without).not.toContain('SCORING SCALE');
  });

  it('ScoringScaleBlockPrecedesSupplementalMaterials', () => {
    const message = buildUserMessage({
      courseSettingsText: 'p',
      cleanedAssignmentText: 'a',
      rubric: null,
      studentSubmissionText: 's',
      additionalInstructions: null,
      gradingKeyText: 'KEY_CONTENT',
      pointsPossible: 12.5,
    });

    const scaleIdx = message.indexOf('SCORING SCALE');
    const suppIdx = message.indexOf('SUPPLEMENTAL GRADING MATERIALS');
    expect(scaleIdx).toBeGreaterThan(0);
    expect(suppIdx).toBeGreaterThan(scaleIdx);
    expect(message).toContain('worth 12.5 points'); // invariant "0.##" formatting
  });
});
