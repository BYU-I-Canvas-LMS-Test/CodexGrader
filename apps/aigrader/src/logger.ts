// Server log: ~/.aigrader/logs/server.log (rotated at 5 MB, one old copy).
// The server never logs tokens or student work — only ids, counts, statuses,
// and plain-English problems.

import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from './state.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type Logger = (message: string) => void;

export function createFileLogger(dir: string, opts: { echo?: boolean } = {}): Logger {
  ensurePrivateDir(dir);
  const file = join(dir, 'server.log');
  return (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (opts.echo) process.stderr.write(line);
    try {
      try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // logging is best-effort
    }
  };
}
