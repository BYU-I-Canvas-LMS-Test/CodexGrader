// Where the local server keeps its per-user state. Everything lives under
// ONE folder in the teacher's home directory — nothing is written anywhere
// else, nothing is registered with the OS:
//
//   ~/.aigrader/                (Windows: %USERPROFILE%\.aigrader\)
//     .env                      the teacher's Canvas URL + token (hand-edited)
//     state/active-runs.json    ids of runs to resume on the next start
//     state/server.json         {port, pid, version} of the running server
//     state/control.key         per-start secret for the control pipe
//     state/control.sock        the control socket (macOS/Linux only)
//     audit/audit-YYYY-MM.jsonl local audit trail (ids and counts only)
//     ledger/<runId>.jsonl      local post ledger (ids only) — double-post guard
//     logs/server.log           server log (never tokens, never student work)
//
// AIGRADER_HOME relocates the whole folder (tests; a second profile);
// AIGRADER_ENV_FILE (or --env-file) points at a different .env.

import { createHash } from 'node:crypto';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

export interface AigraderPaths {
  home: string;
  envFile: string;
  stateDir: string;
  activeRunsFile: string;
  serverJsonFile: string;
  controlKeyFile: string;
  /** Named pipe (Windows) or Unix socket path — also the single-instance lock. */
  controlEndpoint: string;
  auditDir: string;
  ledgerDir: string;
  logsDir: string;
}

/** Unix socket paths are limited to ~104 bytes on macOS. */
const MAX_SOCKET_PATH = 100;

export function resolvePaths(
  opts: {
    env?: NodeJS.ProcessEnv;
    envFile?: string;
    platform?: NodeJS.Platform;
  } = {},
): AigraderPaths {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = env.AIGRADER_HOME?.trim() || join(homedir(), '.aigrader');
  const stateDir = join(home, 'state');
  return {
    home,
    envFile: opts.envFile ?? (env.AIGRADER_ENV_FILE?.trim() || join(home, '.env')),
    stateDir,
    activeRunsFile: join(stateDir, 'active-runs.json'),
    serverJsonFile: join(stateDir, 'server.json'),
    controlKeyFile: join(stateDir, 'control.key'),
    controlEndpoint: controlEndpointFor(home, stateDir, platform),
    auditDir: join(home, 'audit'),
    ledgerDir: join(home, 'ledger'),
    logsDir: join(home, 'logs'),
  };
}

function controlEndpointFor(home: string, stateDir: string, platform: NodeJS.Platform): string {
  // One endpoint per (user, home folder): two profiles never collide, and
  // the name is stable across restarts (it IS the single-instance lock).
  let user = 'user';
  try {
    user = userInfo().username;
  } catch {
    // no passwd entry (containers) — the home path still disambiguates
  }
  const tag = createHash('sha256').update(`${user}\0${home}`).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\aigrader-${tag}`;
  const inState = join(stateDir, 'control.sock');
  return inState.length <= MAX_SOCKET_PATH ? inState : join(tmpdir(), `aigrader-${tag}.sock`);
}
