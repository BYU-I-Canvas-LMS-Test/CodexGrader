#!/usr/bin/env node
// Fails (exit 1) if any hosted-SaaS or former-brand residue reappears in the
// source tree: the old product name, the old company, Firebase/Firestore,
// Gemini/Vertex, KMS, or the page-credit ledger. Run in CI on every push.
//
// Scans tracked source/config/docs files; skips build output, dependencies,
// the lockfile, the build plan (it documents what was removed), and this
// script itself.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const FORBIDDEN = [
  /\bwren\b/i,
  /aliduck/i,
  /@11hg\b|\b11hg:/i,
  /eleventh[- ]hour|11th hour/i,
  /firebase/i,
  /firestore/i,
  /\bgemini\b/i,
  /vertex ?ai|@google\/genai/i,
  /@google-cloud\/kms|\bkms\b/i,
  /page[- ]?ledger|pageLedger|page credits?\b/i,
  /google-auth-library/i,
];

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.git', '.turbo']);
const SKIP_FILES = new Set([
  'pnpm-lock.yaml',
  // Local-only working notes (git-ignored, never published).
  join('docs', 'PLAN.md'),
  'CLAUDE.md',
  join('scripts', 'check-no-legacy.mjs'),
]);
const TEXT_EXT = /\.(ts|tsx|mts|mjs|cjs|js|json|css|md|yml|yaml|txt|html|toml|ps1|sh)$/i;

const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (SKIP_FILES.has(rel) || !TEXT_EXT.test(name)) continue;
    const lines = readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const pattern of FORBIDDEN) {
        if (pattern.test(line)) {
          hits.push(`${rel.split(sep).join('/')}:${i + 1}: ${line.trim().slice(0, 140)}`);
          break;
        }
      }
    });
  }
}

walk(ROOT);

if (hits.length > 0) {
  console.error(`Legacy/SaaS residue found (${hits.length}):`);
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log('No legacy/SaaS residue found.');
