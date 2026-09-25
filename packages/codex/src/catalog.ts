// The worker's model catalog. Recent Codex models carry their tools in the
// catalog itself (`tool_mode: "code_mode_only"`, multi-agent versions, apply-
// patch and web-search tool types) — feature switches alone don't remove
// them. So the worker runs with its own copy of the teacher's catalog
// (`codex debug models`, the account-refreshed list) with every tool field
// stripped, passed via `-c model_catalog_json=…`. Measured effect: the
// model-visible input for a tiny prompt drops from ~5,000 tokens of tool
// definitions to ~130 — the calibrated instructions and the user message,
// nothing else.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CodexCommand } from './process.js';
import { runCodex } from './process.js';

export interface CatalogModel {
  slug: string;
  displayName: string;
  listed: boolean;
  priority: number;
  reasoningLevels: string[];
  defaultReasoning: string | null;
  acceptsImages: boolean;
}

export interface WorkerCatalog {
  file: string;
  models: CatalogModel[];
  /** The account's first listed model (lowest priority number). */
  defaultModel: string | null;
  /** 'live' = refreshed for this account; 'bundled' = offline fallback. */
  source: 'live' | 'bundled';
}

/** Catalog fields that hand the model tools or extra instructions. */
const TOOL_FIELDS = [
  'tool_mode',
  'multi_agent_version',
  'multi_agent_reasoning_effort',
  'apply_patch_tool_type',
  'web_search_tool_type',
];

type RawModel = Record<string, unknown> & { slug?: unknown };

/** Returns a tool-free copy of a raw catalog document ({models:[…]}). */
export function sanitizeCatalog(raw: unknown): { models: RawModel[] } {
  const doc = raw as { models?: unknown };
  if (!doc || !Array.isArray(doc.models)) throw new Error('Unexpected Codex model catalog format.');
  const models = (doc.models as RawModel[]).map((m) => {
    const copy: RawModel = { ...m };
    for (const field of TOOL_FIELDS) delete copy[field];
    copy.supports_search_tool = false;
    copy.experimental_supported_tools = [];
    copy.node_repl_disabled = true;
    copy.include_skills_usage_instructions = false;
    copy.include_plugin_usage_instructions = false;
    copy.include_apps_usage_instructions = false;
    return copy;
  });
  return { ...(raw as object), models };
}

export function summarizeCatalog(raw: { models: RawModel[] }): { models: CatalogModel[]; defaultModel: string | null } {
  const models: CatalogModel[] = raw.models
    .filter((m) => typeof m.slug === 'string')
    .map((m) => ({
      slug: m.slug as string,
      displayName: typeof m.display_name === 'string' ? m.display_name : (m.slug as string),
      listed: m.visibility === 'list',
      priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER,
      reasoningLevels: Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as Array<{ effort?: string } | string>).map((l) =>
            typeof l === 'string' ? l : (l.effort ?? ''),
          ).filter(Boolean)
        : [],
      defaultReasoning: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null,
      acceptsImages: Array.isArray(m.input_modalities) && (m.input_modalities as unknown[]).includes('image'),
    }));
  const listed = models.filter((m) => m.listed).sort((a, b) => a.priority - b.priority);
  return { models, defaultModel: listed[0]?.slug ?? null };
}

/** Builds (or refreshes) the worker catalog file. */
export async function prepareWorkerCatalog(
  cmd: CodexCommand,
  file: string,
  timeoutMs = 30_000,
): Promise<WorkerCatalog> {
  let source: WorkerCatalog['source'] = 'live';
  let res = await runCodex(cmd, { args: ['debug', 'models'], timeoutMs });
  let raw = tryParse(res.stdout);
  if (!raw) {
    source = 'bundled';
    res = await runCodex(cmd, { args: ['debug', 'models', '--bundled'], timeoutMs });
    raw = tryParse(res.stdout);
  }
  if (!raw) throw new Error('Could not read the Codex model catalog.');
  const clean = sanitizeCatalog(raw);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
  renameSync(tmp, file);
  return { file, source, ...summarizeCatalog(clean) };
}

function tryParse(text: string): unknown {
  try {
    const value = JSON.parse(text) as { models?: unknown };
    return Array.isArray(value?.models) ? value : null;
  } catch {
    return null;
  }
}
