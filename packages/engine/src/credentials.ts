// Local Canvas credentials: the teacher's own base URL + personal access
// token(s), read from ~/.aigrader/.env by the local server (apps/aigrader's
// EnvConfigLoader) and handed to the engine through this provider. This is
// the ONLY place a Canvas token lives in the engine; there is no server-side
// token store of any kind.
//
// A teacher may configure more than one Canvas instance (CANVAS_BASE_URL_2 /
// CANVAS_API_TOKEN_2 — e.g. byui + byupw). Course ids are only unique per
// instance, so every lookup is by HOST: the course key's host picks the
// credential. `null`/absent host = the primary (first) instance.
//
// NEVER log a token. `tokenSha256` is the safe identifier (gate-registry key).

import { createHash } from 'node:crypto';
import { normalizeHost } from '@aigrader/canvas';

/** One configured Canvas instance + its bearer token. */
export interface CanvasCredential {
  /** https origin, e.g. "https://byui.instructure.com". */
  baseUrl: string;
  /** Bare lowercase host, e.g. "byui.instructure.com". */
  host: string;
  /** The PLAINTEXT bearer token. Pass to the Canvas client only. */
  token: string;
  /** sha256(token) hex — safe to log; keys the per-token request gate. */
  tokenSha256: string;
}

/** Why a credential lookup failed (routes map these onto HTTP statuses). */
export class CredentialError extends Error {
  constructor(
    readonly code: 'not_configured' | 'unknown_host',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** The engine's view of the teacher's configured Canvas instances. */
export interface CanvasCredentialProvider {
  /** Credential for a Canvas host; null/undefined = the primary instance.
   * Throws CredentialError when nothing (or not that host) is configured. */
  forHost(host: string | null | undefined): CanvasCredential;
  /** Every configured instance (primary first). Tokens included — callers
   * must never serialize these. */
  list(): readonly CanvasCredential[];
}

/** One raw entry as parsed from the .env file. */
export interface CredentialEntry {
  baseUrl: string;
  token: string;
}

/** sha256 hex of a token (the gate key). */
export function tokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Normalizes raw .env entries into credentials (drops blanks, dedupes hosts;
 * the first entry for a host wins). */
export function toCredentials(entries: readonly CredentialEntry[]): CanvasCredential[] {
  const seen = new Set<string>();
  const out: CanvasCredential[] = [];
  for (const entry of entries) {
    const host = normalizeHost(entry.baseUrl);
    const token = entry.token.trim();
    if (!host || !token || seen.has(host)) continue;
    seen.add(host);
    out.push({ baseUrl: `https://${host}`, host, token, tokenSha256: tokenSha256(token) });
  }
  return out;
}

/**
 * A provider over an in-memory credential list. `replace()` swaps the list
 * atomically — the local server calls it when the .env file changes, so a
 * rotated token takes effect without a restart.
 */
export class StaticCredentialProvider implements CanvasCredentialProvider {
  private credentials: CanvasCredential[];

  constructor(entries: readonly CredentialEntry[] = []) {
    this.credentials = toCredentials(entries);
  }

  /** Swap in a freshly parsed .env (e.g. after the teacher rotated a token). */
  replace(entries: readonly CredentialEntry[]): void {
    this.credentials = toCredentials(entries);
  }

  list(): readonly CanvasCredential[] {
    return this.credentials;
  }

  forHost(host: string | null | undefined): CanvasCredential {
    if (this.credentials.length === 0) {
      throw new CredentialError(
        'not_configured',
        'No Canvas access token is configured. Add CANVAS_BASE_URL and CANVAS_API_TOKEN to ~/.aigrader/.env.',
      );
    }
    const wanted = normalizeHost(host ?? null);
    if (wanted === null) return this.credentials[0]!;
    const match = this.credentials.find((c) => c.host === wanted);
    if (!match) {
      throw new CredentialError(
        'unknown_host',
        `No Canvas access token is configured for ${wanted}. Add it to ~/.aigrader/.env as CANVAS_BASE_URL_2 / CANVAS_API_TOKEN_2.`,
      );
    }
    return match;
  }
}
