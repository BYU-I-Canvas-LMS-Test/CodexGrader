// Grader Settings: settings.json parsing (bad fields dropped, never fatal),
// precedence (saved > .env > defaults), and update validation against the
// teacher's Codex account.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  effectiveSettings,
  readSavedSettings,
  validateSettingsUpdate,
  writeSavedSettings,
} from '../src/grading-settings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aigrader-settings-'));
  file = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MODELS = [
  { slug: 'gpt-a', displayName: 'GPT A', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'medium' },
  { slug: 'gpt-b', displayName: 'GPT B', reasoningLevels: ['low', 'medium'], defaultReasoning: 'low' },
];
const CURRENT = { model: '', reasoningEffort: 'medium', maxWorkers: 2 };

describe('settings.json', () => {
  it('round-trips, and a missing file means no saved settings', () => {
    expect(readSavedSettings(file)).toEqual({});
    writeSavedSettings(file, { model: 'gpt-a', reasoningEffort: 'high', maxWorkers: 3 });
    expect(readSavedSettings(file)).toEqual({ model: 'gpt-a', reasoningEffort: 'high', maxWorkers: 3 });
  });

  it('drops bad fields (with a warning) and survives a damaged file', () => {
    const warnings: string[] = [];
    writeFileSync(file, JSON.stringify({ model: 'gpt a; rm', reasoningEffort: 'high', maxWorkers: 40 }));
    expect(readSavedSettings(file, (m) => warnings.push(m))).toEqual({ reasoningEffort: 'high' });
    expect(warnings).toHaveLength(2);

    writeFileSync(file, '{ not json');
    expect(readSavedSettings(file, (m) => warnings.push(m))).toEqual({});
    expect(warnings).toHaveLength(3);
  });

  it('saved settings win over .env, which wins over the defaults', () => {
    expect(effectiveSettings({}, {})).toEqual({ model: '', reasoningEffort: 'medium', maxWorkers: 2 });
    const env = { model: 'gpt-b', reasoningEffort: 'low', maxWorkers: 1 };
    expect(effectiveSettings(env, {})).toEqual(env);
    // '' (the account default) saved on purpose still beats the .env model.
    expect(effectiveSettings(env, { model: '', maxWorkers: 4 })).toEqual({ model: '', reasoningEffort: 'low', maxWorkers: 4 });
  });
});

describe('validateSettingsUpdate', () => {
  it('merges a partial update onto the current settings', () => {
    expect(validateSettingsUpdate({ maxWorkers: 4 }, CURRENT, MODELS, 'gpt-a')).toEqual({
      ok: true,
      settings: { model: '', reasoningEffort: 'medium', maxWorkers: 4 },
    });
    expect(validateSettingsUpdate({ model: 'gpt-a', reasoningEffort: 'xhigh' }, CURRENT, MODELS, 'gpt-a')).toMatchObject({
      ok: true,
      settings: { model: 'gpt-a', reasoningEffort: 'xhigh' },
    });
  });

  it('refuses models the account lacks and levels the model lacks', () => {
    expect(validateSettingsUpdate({ model: 'gpt-z' }, CURRENT, MODELS, 'gpt-a')).toMatchObject({ ok: false });
    expect(validateSettingsUpdate({ model: 'gpt-b', reasoningEffort: 'high' }, CURRENT, MODELS, 'gpt-a')).toMatchObject({
      ok: false,
      message: 'GPT B does not support High thinking. Choose another level.',
    });
    // The default model's levels apply when no model is chosen.
    expect(validateSettingsUpdate({ reasoningEffort: 'high' }, CURRENT, MODELS, 'gpt-b')).toMatchObject({ ok: false });
  });

  it('refuses malformed input', () => {
    for (const bad of [null, [], 'x', { maxWorkers: 0 }, { maxWorkers: '2' }, { reasoningEffort: 'HIGH' }, { model: 42 }]) {
      expect(validateSettingsUpdate(bad, CURRENT, MODELS, 'gpt-a')).toMatchObject({ ok: false });
    }
  });

  it('keeps a saved model while Codex is still starting (no list yet)', () => {
    const current = { ...CURRENT, model: 'gpt-a' };
    expect(validateSettingsUpdate({ model: 'gpt-a', maxWorkers: 1 }, current, [], null)).toMatchObject({ ok: true });
    expect(validateSettingsUpdate({ model: 'gpt-b' }, current, [], null)).toMatchObject({
      ok: false,
      message: expect.stringContaining('not ready yet'),
    });
  });
});
