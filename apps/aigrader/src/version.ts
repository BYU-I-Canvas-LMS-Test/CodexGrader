import { readFileSync } from 'node:fs';

/** This build's version (apps/aigrader/package.json — from src/ or dist/). */
export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
