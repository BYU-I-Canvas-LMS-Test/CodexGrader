// Finds the Codex CLI on a faculty computer. Faculty usually have the Codex
// desktop app, which carries its own CLI (Windows: %LOCALAPPDATA%\OpenAI\
// Codex\bin\<build>\codex.exe — several builds may sit side by side), and
// sometimes an npm or Homebrew install. Search order:
//   1. CODEX_PATH (the .env setting or the environment)
//   2. PATH
//   3. the desktop app's bundled CLI (newest build first)
//   4. npm global and Homebrew locations
// Candidates are only CANDIDATES — `probeCodex` confirms one really is Codex.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export type CodexSource = 'CODEX_PATH' | 'PATH' | 'desktop-app' | 'npm' | 'homebrew';

export interface CodexCandidate {
  path: string;
  source: CodexSource;
}

export interface LocateOptions {
  codexPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

export function codexCandidates(opts: LocateOptions = {}): CodexCandidate[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const win = platform === 'win32';
  const { join, delimiter } = win ? win32 : posix;
  const exe = win ? 'codex.exe' : 'codex';
  const out: CodexCandidate[] = [];
  const add = (path: string | undefined, source: CodexSource) => {
    if (path && !out.some((c) => c.path === path)) out.push({ path, source });
  };

  add(opts.codexPath?.trim() || undefined, 'CODEX_PATH');
  add(env.CODEX_PATH?.trim() || undefined, 'CODEX_PATH');

  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir) add(join(dir, exe), 'PATH');
  }

  if (win) {
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    for (const build of newestFirst(join(localAppData, 'OpenAI', 'Codex', 'bin'), join)) {
      add(join(build, 'codex.exe'), 'desktop-app');
    }
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const vendor = join(appData, 'npm', 'node_modules', '@openai', 'codex', 'vendor');
    for (const triple of newestFirst(vendor, join)) add(join(triple, 'codex', 'codex.exe'), 'npm');
  } else {
    for (const app of ['/Applications/Codex.app', join(home, 'Applications', 'Codex.app')]) {
      add(join(app, 'Contents', 'Resources', 'codex'), 'desktop-app');
      add(join(app, 'Contents', 'MacOS', 'codex'), 'desktop-app');
    }
    add('/opt/homebrew/bin/codex', 'homebrew');
    add('/usr/local/bin/codex', 'homebrew');
    add(join(home, '.npm-global', 'bin', 'codex'), 'npm');
    add(join(home, '.local', 'bin', 'codex'), 'npm');
  }
  return out;
}

/** The candidates that exist on disk, in search order. */
export function existingCodexCandidates(
  opts: LocateOptions & { exists?: (path: string) => boolean } = {},
): CodexCandidate[] {
  const exists = opts.exists ?? isFile;
  return codexCandidates(opts).filter((c) => exists(c.path));
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Subdirectories of `dir`, most recently modified first. */
function newestFirst(dir: string, join: (...parts: string[]) => string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const path = join(dir, d.name);
        let mtime = 0;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          // unreadable — sort last
        }
        return { path, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((d) => d.path);
  } catch {
    return [];
  }
}
