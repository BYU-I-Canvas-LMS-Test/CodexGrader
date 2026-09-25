// Small durable state files under ~/.aigrader/state:
//   active-runs.json — the live (non-terminal) progress records, rewritten
//                      whenever that set changes, read back at startup so
//                      the resume sweep can pick interrupted runs up again.
//                      Ids, statuses, and counts only — never student work.
//   server.json      — {port, pid, version, origin, startedAt} of the running
//                      server, for `aigrader status` and humans. No secrets.
// Writes are atomic (temp file + rename) so a crash never leaves half a file.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunProgressDoc } from '@aigrader/shared';

const ACTIVE_RUNS_VERSION = 1;

/** Creates a directory readable only by the current user (POSIX 0700). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Atomic JSON write: temp file in the same folder, then rename over. */
export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode });
  // Windows can refuse a rename for a moment while antivirus scans the target.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 4) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(50 * (attempt + 1));
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

/** The records to seed LocalProgressStore with (unreadable file ⇒ none). */
export function readActiveRuns(file: string, warn: (m: string) => void = () => {}): RunProgressDoc[] {
  const raw = readJson(file);
  if (raw === undefined) return [];
  const runs = (raw as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) {
    warn(`[state] Ignoring unreadable ${file}.`);
    return [];
  }
  return runs.filter(
    (r): r is RunProgressDoc =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as RunProgressDoc).runId === 'string' &&
      typeof (r as RunProgressDoc).courseKey === 'string' &&
      typeof (r as RunProgressDoc).status === 'string',
  );
}

/**
 * A persist callback for LocalProgressStore: writes are serialized and the
 * latest set always wins (a write that fails is retried by the next change).
 */
export function activeRunsWriter(
  file: string,
  warn: (m: string) => void = () => {},
): (live: RunProgressDoc[]) => void {
  return (live) => {
    try {
      writeJsonAtomic(file, {
        version: ACTIVE_RUNS_VERSION,
        updatedAt: new Date().toISOString(),
        runs: live,
      });
    } catch (err) {
      warn(`[state] Could not save the active-runs list: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export interface ServerInfo {
  port: number;
  pid: number;
  version: string;
  origin: string;
  startedAt: string;
}

export function writeServerInfo(file: string, info: ServerInfo): void {
  writeJsonAtomic(file, info);
}

export function readServerInfo(file: string): ServerInfo | null {
  const raw = readJson(file) as Partial<ServerInfo> | undefined;
  if (!raw || typeof raw.port !== 'number' || typeof raw.pid !== 'number') return null;
  return raw as ServerInfo;
}

/** Removes server.json only if it still describes this process. */
export function removeServerInfo(file: string, pid = process.pid): void {
  const info = readServerInfo(file);
  if (info && info.pid !== pid) return;
  rmSync(file, { force: true });
}
