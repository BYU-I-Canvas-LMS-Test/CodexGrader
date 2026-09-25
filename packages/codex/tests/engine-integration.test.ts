// The engine grading through the Codex backend (FakeCodex): a real
// assignment fan-out where every student is one isolated exec — the per-call
// strict schema pins the rubric's exact criterion/rating ids — and a usage
// limit mid-run that PAUSES the run (rows back to PENDING) until the reset.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeCanvas,
  TEST_COURSE_KEY,
  buildEngine,
  shutdown,
  student,
  textSubmission,
  type TestEngineHarness,
} from '../../engine/tests/engine-helpers.js';
import { createCodexBackend } from '../src/backend.js';

const FAKE = fileURLToPath(new URL('./fake-codex/fake-codex.mjs', import.meta.url));
const START = {
  courseKey: TEST_COURSE_KEY,
  faculty: { canvasUserId: 9, name: 'John Doe' },
  target: { kind: 'assignment' as const, assignmentId: 501 },
};

let work: string;
let harness: TestEngineHarness | undefined;
const saved = { ...process.env };

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'aigrader-codex-engine-'));
  process.env.FAKE_CODEX_DIR = join(work, 'fake');
  process.env.FAKE_CODEX_ANSWER = JSON.stringify({
    TotalPoints: '18/20',
    assignmentFeedback: 'Clear thesis; tighten the conclusion.',
    Rubrics: [{ id: '_4692', ratingID: '_r1', points: 18, ratingFeedback: 'Strong.' }],
  });
});

afterEach(async () => {
  if (harness) await shutdown(harness);
  harness = undefined;
  process.env = { ...saved };
  rmSync(work, { recursive: true, force: true });
});

function rubricCanvas(): FakeCanvas {
  const canvas = new FakeCanvas();
  canvas.assignment.rubric = [
    {
      id: '_4692',
      description: 'Thesis',
      long_description: null,
      points: 20,
      learning_outcome_id: null,
      ratings: [
        { id: '_r1', description: 'Full', long_description: null, points: 20 },
        { id: '_r2', description: 'Partial', long_description: null, points: 10 },
      ],
    },
  ];
  canvas.students = [student(1), student(2)];
  canvas.submissions = [textSubmission(1, '<p>Essay one.</p>'), textSubmission(2, '<p>Essay two.</p>')];
  return canvas;
}

function codexEngine() {
  const codex = createCodexBackend({
    command: { command: process.execPath, prefixArgs: [FAKE] },
    stateDir: join(work, 'state'),
    tempRoot: join(work, 'calls'),
  });
  harness = buildEngine({ canvas: rubricCanvas(), modelCall: codex.modelCall });
  return { codex, harness };
}

const calls = () =>
  readFileSync(join(work, 'fake', 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { schema: Record<string, unknown>; system: string; stdin: string; scenario: string });

describe('engine × Codex backend', () => {
  it('drafts every student through an isolated exec with the rubric ids pinned in the schema', async () => {
    const { harness: h } = codexEngine();
    const { runId } = await h.engine.startRun(START);
    await h.engine.onIdle();

    const doc = h.registry.get(runId)!.session.document;
    expect(doc.status).toBe('REVIEWING');
    for (const g of doc.grades) {
      expect(g.status).toBe('DRAFT');
      expect(g.aiDraft).toMatchObject({ totalPoints: '18/20', rubrics: [{ criterionId: '_4692', ratingId: '_r1', points: 18 }] });
      expect(g.llm).toMatchObject({ inputTokens: 131, outputTokens: 40 });
    }

    const recorded = calls();
    expect(recorded).toHaveLength(2);
    const schemaText = JSON.stringify(recorded[0]!.schema);
    expect(schemaText).toContain('"enum":["_4692"]');
    expect(schemaText).toContain('"_r1"');
    // The calibrated grading prompt is the system text; the student's work
    // arrives on stdin (and the two never mix).
    expect(recorded[0]!.system.length).toBeGreaterThan(500);
    expect(recorded.map((c) => c.stdin).join('\n')).toMatch(/Essay (one|two)/);
    expect(recorded[0]!.system).not.toMatch(/Essay (one|two)/);
  });

  it('a usage limit mid-run pauses the run until the reset — no row is marked ERROR', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'usage_limit';
    const { harness: h } = codexEngine();
    const { runId } = await h.engine.startRun(START);
    await h.engine.onIdle();

    const live = h.registry.get(runId)!;
    expect(live.paused?.reason).toBe('usage_limit');
    const doc = live.session.document;
    expect(doc.grades.every((g) => g.status === 'PENDING')).toBe(true);
    expect(doc.pausedReason).toBe('usage_limit');
    expect(Date.parse(doc.pausedUntil!) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(h.engine.activity()).toMatchObject({ busy: false, waiting: true });

    // The limit lifts (the auto-resume timer would do this at the reset).
    process.env.FAKE_CODEX_SCENARIO = 'success';
    await h.engine.resume(runId);
    await h.engine.onIdle();
    expect(doc.grades.every((g) => g.status === 'DRAFT')).toBe(true);
    expect(doc.pausedReason).toBeUndefined();
  });
});
