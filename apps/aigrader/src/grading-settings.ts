// Grader Settings — the grading preferences a teacher picks in the review
// page: how many students Codex grades at once, which model, and how hard it
// thinks. Saved in ~/.aigrader/settings.json so nobody has to edit .env. The
// older AIGRADER_MAX_WORKERS / AIGRADER_MODEL / AIGRADER_REASONING_EFFORT
// lines in .env still work as starting values until the first save.
//
// These are per-computer preferences, not grading state: every run records
// the model and thinking level it used on its own Canvas document.

import { existsSync } from 'node:fs';
import type { GradingModelOption, GradingSettings } from '@aigrader/shared';
import type { EnvSettings } from './env-config.js';
import { readJson, writeJsonAtomic } from './state.js';

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DEFAULT_REASONING_EFFORT = 'medium';
export const WORKERS = { min: 1, max: 4, recommended: 2 } as const;

/** What settings.json holds (every field optional). */
export type SavedSettings = Partial<GradingSettings>;

const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function isEffort(value: unknown): value is string {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

function isWorkers(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= WORKERS.min && (value as number) <= WORKERS.max;
}

function isModel(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || MODEL_SLUG.test(value));
}

/** settings.json → the fields that are valid (a bad field is dropped with a warning). */
export function readSavedSettings(file: string, warn: (message: string) => void = () => {}): SavedSettings {
  if (!existsSync(file)) return {};
  const json = readJson(file);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    warn(`[config] ${file} could not be read; using the default grading settings.`);
    return {};
  }
  const raw = json as Record<string, unknown>;
  const saved: SavedSettings = {};
  if (raw.model !== undefined) {
    if (isModel(raw.model)) saved.model = raw.model;
    else warn(`[config] Ignoring the saved grading model in ${file}.`);
  }
  if (raw.reasoningEffort !== undefined) {
    if (isEffort(raw.reasoningEffort)) saved.reasoningEffort = raw.reasoningEffort;
    else warn(`[config] Ignoring the saved thinking level in ${file}.`);
  }
  if (raw.maxWorkers !== undefined) {
    if (isWorkers(raw.maxWorkers)) saved.maxWorkers = raw.maxWorkers;
    else warn(`[config] Ignoring the saved worker count in ${file}.`);
  }
  return saved;
}

export function writeSavedSettings(file: string, settings: GradingSettings): void {
  writeJsonAtomic(file, { schemaVersion: 1, ...settings });
}

/** Saved settings win, then .env, then the defaults. */
export function effectiveSettings(env: EnvSettings, saved: SavedSettings): GradingSettings {
  return {
    model: saved.model ?? env.model ?? '',
    reasoningEffort: saved.reasoningEffort ?? env.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    maxWorkers: saved.maxWorkers ?? env.maxWorkers ?? WORKERS.recommended,
  };
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};

export type SettingsValidation = { ok: true; settings: GradingSettings } | { ok: false; message: string };

/**
 * Checks an update from the review page against the current settings and
 * what this Codex account offers. `models` is empty while Codex starts; a
 * model can only be chosen from a known list (or '' = the account default).
 */
export function validateSettingsUpdate(
  update: unknown,
  current: GradingSettings,
  models: GradingModelOption[],
  defaultModel: string | null,
): SettingsValidation {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) {
    return { ok: false, message: 'Send the settings as a JSON object.' };
  }
  const input = update as Record<string, unknown>;
  const next: GradingSettings = { ...current };

  if (input.maxWorkers !== undefined) {
    if (!isWorkers(input.maxWorkers)) {
      return { ok: false, message: `Students graded at once must be a whole number from ${WORKERS.min} to ${WORKERS.max}.` };
    }
    next.maxWorkers = input.maxWorkers;
  }

  if (input.model !== undefined) {
    const model = typeof input.model === 'string' ? input.model.trim() : input.model;
    if (!isModel(model)) return { ok: false, message: 'Choose a model from the list.' };
    if (model !== '' && model !== current.model && !models.some((m) => m.slug === model)) {
      return {
        ok: false,
        message:
          models.length === 0
            ? 'Codex is not ready yet, so the model list is not available. Try again in a moment.'
            : `${model} is not available on your Codex account. Choose a model from the list.`,
      };
    }
    next.model = model;
  }

  if (input.reasoningEffort !== undefined) {
    if (!isEffort(input.reasoningEffort)) {
      return { ok: false, message: 'Choose a thinking level from the list.' };
    }
    next.reasoningEffort = input.reasoningEffort;
  }

  const slug = next.model || defaultModel;
  const option = models.find((m) => m.slug === slug);
  if (option && option.reasoningLevels.length > 0 && !option.reasoningLevels.includes(next.reasoningEffort)) {
    return {
      ok: false,
      message: `${option.displayName} does not support ${EFFORT_LABELS[next.reasoningEffort] ?? next.reasoningEffort} thinking. Choose another level.`,
    };
  }
  return { ok: true, settings: next };
}
