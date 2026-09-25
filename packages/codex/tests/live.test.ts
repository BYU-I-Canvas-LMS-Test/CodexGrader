// LIVE Codex check (skipped unless AIGRADER_LIVE_CODEX=1): the REAL Codex on
// this machine grades one synthetic submission with the REAL calibrated
// grading prompt and the REAL strict rubric schema — proving Codex accepts
// the schema (enums, nested arrays) and the answer passes the engine's Zod
// validation. Synthetic content only; uses a little of the teacher's quota.
//
//   AIGRADER_LIVE_CODEX=1 corepack pnpm --filter @aigrader/codex exec vitest run tests/live.test.ts

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StructuredGradingClient } from '@aigrader/engine';
import { composeSystemPrompt } from '../../engine/src/grading/prompts/system-prompt.js';
import { buildUserMessage } from '../../engine/src/grading/prompts/user-template.js';
import { createCodexBackend } from '../src/backend.js';

const RUBRIC = [
  {
    id: '_4692',
    points: 10,
    description: 'Correctness',
    long_description: 'Is the arithmetic right?',
    ratings: [
      { id: '_r_full', points: 10, description: 'Correct', long_description: '' },
      { id: 'blank', points: 0, description: 'Incorrect', long_description: '' },
    ],
  },
  {
    id: '_7710',
    points: 5,
    description: 'Explanation',
    long_description: 'Does the student show their reasoning?',
    ratings: [
      { id: '_r_clear', points: 5, description: 'Clear', long_description: '' },
      { id: '_r_none', points: 0, description: 'Missing', long_description: '' },
    ],
  },
];

describe.skipIf(process.env.AIGRADER_LIVE_CODEX !== '1')('live Codex', () => {
  it('grades a synthetic submission with the calibrated prompt and exact rubric ids', async () => {
    const state = mkdtempSync(join(tmpdir(), 'aigrader-live-'));
    try {
      const codex = createCodexBackend({ stateDir: state, log: (m) => console.log(m) });
      const status = await codex.ready;
      expect(status.state).toBe('ready');

      const llm = new StructuredGradingClient({ modelCall: codex.modelCall });
      const started = Date.now();
      const result = await llm.gradeSubmission({
        systemPrompt: composeSystemPrompt({ vision: false, mixedRubricIds: true }),
        userMessage: buildUserMessage({
          courseSettingsText: 'Intro math course. Be encouraging but accurate.',
          cleanedAssignmentText: 'Compute 7 x 8 and explain how you got your answer.',
          rubric: RUBRIC,
          studentSubmissionText: '7 x 8 = 54. I added 7 eight times.',
          additionalInstructions: null,
          pointsPossible: 15,
        }),
        criteria: RUBRIC.map((c) => ({ id: c.id, ratingIds: c.ratings.map((r) => r.id) })),
        model: status.defaultModel ?? '',
        reasoningEffort: 'low',
      });
      console.log('live result', Date.now() - started, 'ms', JSON.stringify(result));
      const ids = result.output.Rubrics.map((r) => r.id).sort();
      expect(ids).toEqual(['_4692', '_7710']);
      for (const r of result.output.Rubrics) {
        const criterion = RUBRIC.find((c) => c.id === r.id)!;
        expect(criterion.ratings.map((x) => x.id)).toContain(r.ratingID);
      }
      expect(result.output.TotalPoints).toMatch(/^\d+(\.\d+)?\/15$/);
      expect(result.stats.model).toBe(status.defaultModel);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  }, 180_000);
});
