// EnvConfigLoader — reads the teacher's hand-edited ~/.aigrader/.env.
//
// Teachers type (or paste) two values into this file, usually in Notepad or
// TextEdit, so the parser is deliberately forgiving:
//   - a UTF-8 BOM (Notepad), CRLF line endings, `export KEY=…` lines
//   - "double", 'single', or “smart” quotes (TextEdit / Word autocorrect)
//   - inline `# comments` after unquoted values
//   - a token pasted as `Bearer 1234~abcd…`, or with a stray line break
//   - a base URL pasted from the address bar (https://byui.instructure.com/
//     courses/123), with /api/v1, or without https:// at all
// …and deliberately strict about what matters: https only, no credentials
// in the URL, port 443 only, a real hostname (never an IP or localhost).
// Every refusal is one plain-English sentence saying how to fix it.
//
// SECRECY: the token never leaves this module except inside `entries`
// (handed straight to the credential provider). `instances` and every
// message show at most its last four characters.

import { existsSync, readFileSync, statSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { isIP } from 'node:net';
import { tokenSha256, type CredentialEntry } from '@aigrader/engine';

/** Optional tuning knobs (all have defaults). */
export interface EnvSettings {
  model?: string;
  reasoningEffort?: string;
  maxWorkers?: number;
  uiPort?: number;
  codexPath?: string;
  /** Pause grading at this % of any Codex usage window (default 85). */
  quotaStopPercent?: number;
}

/** One configured Canvas instance, safe to show (no token). */
export interface InstanceSummary {
  /** 1 = CANVAS_BASE_URL / CANVAS_API_TOKEN, 2 = the _2 pair, … */
  index: number;
  baseUrl: string;
  host: string;
  /** "…a1b2" — the last four characters, or null when the token is missing. */
  tokenHint: string | null;
}

export interface EnvConfig {
  file: string;
  exists: boolean;
  /** Complete (base URL + token) instances, primary first. Contains tokens. */
  entries: CredentialEntry[];
  instances: InstanceSummary[];
  settings: EnvSettings;
  /** Plain-English problems (never containing a token). */
  problems: string[];
}

const MAX_INSTANCES = 9;
const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '”': '”', '’': '’' };

// -------------------------------------------------------------- parsing --

/** KEY=value pairs from .env text (keys upper-cased; last one wins). */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = text.replace(/^﻿/, '');
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^export\s+/i.test(line)) line = line.replace(/^export\s+/i, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    out.set(key, unquote(line.slice(eq + 1).trim()));
  }
  return out;
}

function unquote(value: string): string {
  const open = value[0];
  if (open && QUOTES[open]) {
    const close = QUOTES[open]!;
    const end = value.indexOf(close, 1);
    // An unterminated quote keeps everything after the opening mark.
    return (end > 0 ? value.slice(1, end) : value.slice(1)).trim();
  }
  // Unquoted: an inline comment starts at whitespace + '#' — or right away
  // for an empty value (`KEY=   # comment`; the whitespace was trimmed).
  if (value.startsWith('#')) return '';
  const hash = value.search(/\s#/);
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

export type BaseUrlResult = { ok: true; baseUrl: string; host: string } | { ok: false; problem: string };

/** Canonical https origin for a pasted Canvas address, or why not. */
export function normalizeBaseUrl(raw: string, key = 'CANVAS_BASE_URL'): BaseUrlResult {
  let value = raw.trim().replace(/^<|>$/g, '');
  if (value === '') return { ok: false, problem: `${key} is empty. Set it to your Canvas address, for example https://byui.instructure.com.` };
  if (/^http:\/\//i.test(value)) {
    return {
      ok: false,
      problem: `${key} starts with http:// — Canvas needs a secure address. Change it to start with https://.`,
    };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: `${key} is not a web address. Set it to your Canvas address, for example https://byui.instructure.com.` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, problem: `${key} must start with https://.` };
  }
  if (url.username || url.password) {
    return { ok: false, problem: `${key} must not contain a user name or password — use just the Canvas address.` };
  }
  if (url.port && url.port !== '443') {
    return { ok: false, problem: `${key} must not include a port number (like :8080) — use just the Canvas address.` };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isIP(host.replace(/^\[|\]$/g, '')) !== 0 || !host.includes('.')) {
    return {
      ok: false,
      problem: `${key} must be your school's Canvas address (for example https://byui.instructure.com), not ${host}.`,
    };
  }
  // Anything after the host (/api/v1, /courses/123, ?query) is dropped.
  return { ok: true, baseUrl: `https://${host}`, host };
}

/** A pasted token without quotes, "Bearer ", or stray whitespace. */
export function normalizeToken(raw: string): string {
  return raw.trim().replace(/^bearer\s+/i, '').replace(/\s+/g, '');
}

function tokenProblem(token: string, key: string): string | null {
  if (token === '') return `${key} is empty. Paste the access token you generated in Canvas (Account → Settings → New Access Token).`;
  if (/^https?:/i.test(token)) return `${key} looks like a web address. Put the Canvas address in CANVAS_BASE_URL and the access token in ${key}.`;
  if (/^(your|paste|<)/i.test(token)) return `${key} still has the placeholder text. Replace it with your Canvas access token.`;
  if (token.length < 20) return `${key} looks too short to be a Canvas access token. Copy the whole token again from Canvas.`;
  return null;
}

/** "…a1b2" */
export function tokenHint(token: string): string {
  return `…${token.slice(-4)}`;
}

function intSetting(
  vars: Map<string, string>,
  key: string,
  min: number,
  max: number,
  problems: string[],
): number | undefined {
  const raw = vars.get(key);
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${key} must be a whole number from ${min} to ${max}; using the default.`);
    return undefined;
  }
  return n;
}

/** Parses .env text (null = the file doesn't exist). */
export function parseEnvConfig(text: string | null, file: string): EnvConfig {
  const problems: string[] = [];
  const entries: CredentialEntry[] = [];
  const instances: InstanceSummary[] = [];
  if (text === null) {
    return {
      file,
      exists: false,
      entries,
      instances,
      settings: {},
      problems: [`The settings file ${file} does not exist yet. Run \`aigrader setup\` to create it.`],
    };
  }
  const vars = parseEnvText(text);
  const seenHosts = new Set<string>();

  for (let i = 1; i <= MAX_INSTANCES; i++) {
    const suffix = i === 1 ? '' : `_${i}`;
    const urlKey = `CANVAS_BASE_URL${suffix}`;
    const tokenKey = `CANVAS_API_TOKEN${suffix}`;
    const rawUrl = vars.get(urlKey);
    const rawToken = vars.get(tokenKey);
    if (rawUrl === undefined && rawToken === undefined) continue;
    if ((rawUrl ?? '') === '' && (rawToken ?? '') === '' && i > 1) continue; // commented template

    const url = normalizeBaseUrl(rawUrl ?? '', urlKey);
    const token = normalizeToken(rawToken ?? '');
    const tProblem = tokenProblem(token, tokenKey);
    if (!url.ok) problems.push(url.problem);
    if (tProblem) problems.push(tProblem);
    if (!url.ok) continue;
    if (seenHosts.has(url.host)) {
      problems.push(`${urlKey} repeats ${url.host}; only the first token for a Canvas address is used.`);
      continue;
    }
    seenHosts.add(url.host);
    instances.push({
      index: i,
      baseUrl: url.baseUrl,
      host: url.host,
      tokenHint: tProblem ? null : tokenHint(token),
    });
    if (!tProblem) entries.push({ baseUrl: url.baseUrl, token });
  }
  if (instances.length === 0 && problems.length === 0) {
    problems.push('CANVAS_BASE_URL and CANVAS_API_TOKEN are not set in the settings file.');
  }

  const settings: EnvSettings = {};
  const model = vars.get('AIGRADER_MODEL');
  if (model) settings.model = model;
  const effort = vars.get('AIGRADER_REASONING_EFFORT')?.toLowerCase();
  if (effort) {
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) settings.reasoningEffort = effort;
    else problems.push('AIGRADER_REASONING_EFFORT must be low, medium, high, xhigh, or max; using medium.');
  }
  const workers = intSetting(vars, 'AIGRADER_MAX_WORKERS', 1, 4, problems);
  if (workers !== undefined) settings.maxWorkers = workers;
  const port = intSetting(vars, 'AIGRADER_UI_PORT', 1024, 65535, problems);
  if (port !== undefined) settings.uiPort = port;
  const codexPath = vars.get('CODEX_PATH');
  if (codexPath) settings.codexPath = codexPath;
  const stop = intSetting(vars, 'AIGRADER_QUOTA_STOP_PERCENT', 50, 100, problems);
  if (stop !== undefined) settings.quotaStopPercent = stop;

  return { file, exists: true, entries, instances, settings, problems };
}

// --------------------------------------------------------------- loader --

export interface EnvConfigLoaderOptions {
  /** Called after a reload that changed the parsed config. */
  onChange?: (config: EnvConfig) => void;
  /** Poll interval for the file watcher (ms). */
  pollMs?: number;
}

/**
 * Loads the .env file and (optionally) watches it: editors often replace
 * the file instead of writing in place, so the watcher polls the file's
 * stat (fs.watchFile) rather than trusting change events.
 */
export class EnvConfigLoader {
  private config: EnvConfig;
  private watching = false;
  private readonly listener = (curr: Stats, prev: Stats) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size && curr.ino === prev.ino) return;
    this.reload();
  };

  constructor(
    readonly file: string,
    private readonly options: EnvConfigLoaderOptions = {},
  ) {
    this.config = this.read();
  }

  get current(): EnvConfig {
    return this.config;
  }

  /** Re-reads the file; fires onChange when anything that matters changed. */
  reload(): EnvConfig {
    const next = this.read();
    const changed = fingerprint(next) !== fingerprint(this.config);
    this.config = next;
    if (changed) this.options.onChange?.(next);
    return next;
  }

  watch(): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.file, { interval: this.options.pollMs ?? 1500, persistent: false }, this.listener);
  }

  close(): void {
    if (!this.watching) return;
    this.watching = false;
    unwatchFile(this.file, this.listener);
  }

  private read(): EnvConfig {
    let text: string | null = null;
    try {
      if (existsSync(this.file) && statSync(this.file).isFile()) text = readFileSync(this.file, 'utf8');
    } catch {
      text = null;
    }
    return parseEnvConfig(text, this.file);
  }
}

/** Change detection (token hashes, never the tokens themselves). */
function fingerprint(config: EnvConfig): string {
  return JSON.stringify([
    config.exists,
    config.entries.map((e) => [e.baseUrl, tokenSha256(e.token)]),
    config.settings,
    config.problems,
  ]);
}
