// What this Codex build can do, read from the binary itself (never assumed
// from a version number): the `exec` flags it accepts, its feature table
// (so every tool-bearing feature can be switched off by name — including
// ones added after this code was written), and whether the teacher is
// signed in.

import type { CodexCommand } from './process.js';
import { runCodex } from './process.js';

/** `codex exec` flags the isolated worker depends on. */
export const REQUIRED_EXEC_FLAGS = [
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--sandbox',
  '--cd',
  '--output-schema',
  '--output-last-message',
  '--json',
  '--image',
  '--disable',
  '--strict-config',
] as const;

/**
 * Features that stay ON in the worker: plumbing with no model-visible tools.
 * EVERY other enabled feature is disabled — deny by default, so a feature
 * added in a future Codex release can't quietly hand the grader a tool.
 */
export const SAFE_FEATURES: ReadonlySet<string> = new Set([
  'content_item_kinds',
  'compaction_image_budget',
  'enable_request_compression',
  'secret_auth_storage',
  'system_proxy_fallback',
  'unbounded_connection_retries',
]);

export interface FeatureRow {
  name: string;
  stage: string;
  enabled: boolean;
}

export interface CodexCapabilities {
  version: string;
  execFlags: ReadonlySet<string>;
  features: readonly FeatureRow[];
  /** Required flags this build lacks (non-empty ⇒ unusable). */
  missingFlags: string[];
  /** `--disable <name>` for each of these. */
  disableFeatures: string[];
}

export class CodexProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexProbeError';
  }
}

export function parseVersion(text: string): string | null {
  const m = /codex(?:-cli)?\s+v?(\d+\.\d+\.\d+[^\s]*)/i.exec(text);
  return m ? m[1]! : null;
}

export function parseExecFlags(helpText: string): Set<string> {
  return new Set(helpText.match(/--[a-z][a-z0-9-]*/g) ?? []);
}

/** Rows of `codex features list`: "<name> <stage words…> <true|false>". */
export function parseFeatures(text: string): FeatureRow[] {
  const rows: FeatureRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9_.]+)\s+(.+?)\s+(true|false)\s*$/.exec(line.trim());
    if (m) rows.push({ name: m[1]!, stage: m[2]!.trim(), enabled: m[3] === 'true' });
  }
  return rows;
}

/** Enabled, still-existing features that are not on the safe list. */
export function featuresToDisable(features: readonly FeatureRow[]): string[] {
  return features
    .filter((f) => f.enabled && f.stage !== 'removed' && !SAFE_FEATURES.has(f.name))
    .map((f) => f.name);
}

export async function probeCodex(cmd: CodexCommand, timeoutMs = 20_000): Promise<CodexCapabilities> {
  const version = await runCodex(cmd, { args: ['--version'], timeoutMs });
  if (version.spawnError) throw new CodexProbeError(`Could not start Codex (${version.spawnError.code ?? version.spawnError.message}).`);
  const parsedVersion = parseVersion(version.stdout + version.stderr);
  if (!parsedVersion) throw new CodexProbeError('That program did not identify itself as the Codex CLI.');

  const help = await runCodex(cmd, { args: ['exec', '--help'], timeoutMs });
  const execFlags = parseExecFlags(help.stdout + help.stderr);
  const features = parseFeatures((await runCodex(cmd, { args: ['features', 'list'], timeoutMs })).stdout);

  const missingFlags: string[] = REQUIRED_EXEC_FLAGS.filter((f) => !execFlags.has(f));
  if (!execFlags.has('--disable') || features.length === 0) {
    // Without a feature table we can't prove the worker has no tools.
    if (!missingFlags.includes('--disable')) missingFlags.push('features list');
  }
  return {
    version: parsedVersion,
    execFlags,
    features,
    missingFlags,
    disableFeatures: featuresToDisable(features),
  };
}

export type LoginState = 'chatgpt' | 'api_key' | 'logged_out' | 'unknown';

/** `codex login status` → how the teacher is signed in. */
export function parseLoginStatus(text: string): LoginState {
  if (/logged in using chatgpt/i.test(text)) return 'chatgpt';
  if (/logged in using (an )?api key/i.test(text)) return 'api_key';
  if (/not logged in|logged out/i.test(text)) return 'logged_out';
  return 'unknown';
}

export async function codexLoginState(cmd: CodexCommand, timeoutMs = 20_000): Promise<LoginState> {
  const res = await runCodex(cmd, { args: ['login', 'status'], timeoutMs });
  return parseLoginStatus(res.stdout + res.stderr);
}
