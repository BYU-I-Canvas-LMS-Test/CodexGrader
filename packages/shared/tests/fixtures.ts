// Test helper: load a C#-shaped fixture document as the exact byte string the
// C# app's StorageJson would produce (normalized to \n; no trailing newline).
import { readFileSync } from 'node:fs';

export function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .trimEnd();
}
