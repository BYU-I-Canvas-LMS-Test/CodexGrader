// Architecture test: EVERY mutating route handler (POST/PUT/PATCH/DELETE)
// under app/api calls browserMutationGuard — session cookie + CSRF + exact
// Origin + Sec-Fetch-Site. A new route that forgets it fails here. The two
// allowlisted POSTs are reads (a JSON body, no state change).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '..', 'app', 'api');

/** POST-as-read routes (no Canvas or run mutation). */
const READ_ONLY_POSTS = new Set([
  'canvas/courses/route.ts', // course picker: verify a staff seat → courseKey
  'submission-preview/route.ts', // viewer conversions (read-only)
]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('mutation guard coverage', () => {
  const files = routeFiles(API_ROOT);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [relative(API_ROOT, f).split(sep).join('/'), f]))(
    '%s guards every mutating handler',
    (rel, full) => {
      const source = readFileSync(full, 'utf8');
      const handlers = [...source.matchAll(/export async function (POST|PUT|PATCH|DELETE)\(([\s\S]*?)\)\s*\{/g)];
      if (handlers.length === 0 || READ_ONLY_POSTS.has(rel)) return;
      for (const handler of handlers) {
        const bodyStart = handler.index! + handler[0].length;
        const firstLines = source.slice(bodyStart, bodyStart + 200);
        expect(firstLines, `${rel} ${handler[1]} must start with browserMutationGuard`).toMatch(
          /^\s*const refused = browserMutationGuard\(req[,)]/,
        );
      }
    },
  );
});
