// The local post ledger (~/.aigrader/ledger/<runId>.jsonl): one line per
// grade this machine successfully posted to Canvas, written (and fsynced)
// BEFORE the run document's checkpoint. If the server dies between Canvas
// accepting a grade and the checkpoint recording PostedAt, the ledger still
// proves the post happened, so writeback never posts it twice.
// Contents are ids only: {key: "u<userId>" | "q<quizSubmissionId>", postedAt}.

import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { PostLedgerPort } from '@aigrader/engine';
import { ensurePrivateDir } from './state.js';

/** Ledger files untouched this long are pruned at startup. */
export const LEDGER_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;

export class FilePostLedger implements PostLedgerPort {
  private readonly cache = new Map<string, Set<string>>();

  constructor(private readonly dir: string) {
    ensurePrivateDir(dir);
  }

  async has(runId: string, key: string): Promise<boolean> {
    return this.load(runId).has(key);
  }

  async record(entry: { runId: string; key: string; postedAt: string }): Promise<void> {
    const line = `${JSON.stringify({ key: entry.key, postedAt: entry.postedAt })}\n`;
    const fd = openSync(this.fileFor(entry.runId), 'a', 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.load(entry.runId).add(entry.key);
  }

  /** Deletes ledger files not written for `maxAgeMs`. */
  prune(maxAgeMs = LEDGER_RETENTION_MS, nowMs = Date.now()): number {
    let removed = 0;
    for (const name of safeList(this.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(this.dir, name);
      try {
        if (nowMs - statSync(file).mtimeMs > maxAgeMs) {
          rmSync(file, { force: true });
          removed++;
        }
      } catch {
        // raced with another prune — fine
      }
    }
    return removed;
  }

  private load(runId: string): Set<string> {
    let keys = this.cache.get(runId);
    if (keys) return keys;
    keys = new Set();
    try {
      for (const line of readFileSync(this.fileFor(runId), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const key = (JSON.parse(line) as { key?: unknown }).key;
          if (typeof key === 'string') keys.add(key);
        } catch {
          // a torn final line from a crash — ignore it
        }
      }
    } catch {
      // no ledger yet for this run
    }
    this.cache.set(runId, keys);
    return keys;
  }

  private fileFor(runId: string): string {
    return join(this.dir, `${runId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
