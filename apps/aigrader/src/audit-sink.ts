// Local audit trail: the shared audit() lines (ids and counts only — the
// field allowlist lives in @aigrader/shared audit.ts) appended to
// ~/.aigrader/audit/audit-YYYY-MM.jsonl. Best-effort: a failed append never
// blocks grading.

import { appendFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditSink } from '@aigrader/shared';
import { ensurePrivateDir } from './state.js';

/** Audit files older than this are pruned at startup. */
export const AUDIT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

export function createJsonlAuditSink(dir: string, now: () => Date = () => new Date()): AuditSink {
  ensurePrivateDir(dir);
  return (line) => {
    const d = now();
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      appendFileSync(join(dir, `audit-${month}.jsonl`), line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // best-effort by contract
    }
  };
}

export function pruneAudit(dir: string, maxAgeMs = AUDIT_RETENTION_MS, nowMs = Date.now()): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^audit-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
    const file = join(dir, name);
    try {
      if (nowMs - statSync(file).mtimeMs > maxAgeMs) rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}
