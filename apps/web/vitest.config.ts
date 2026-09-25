// Vitest stays effectively zero-config (default *.test.ts discovery, node
// env). Two additions:
//   - alias the `server-only` marker package to an empty stub — it throws by
//     design when imported outside a React Server Components bundle, and the
//     route modules under test are legitimately server-only;
//   - resolve sibling workspace packages from TypeScript source (the
//     "@aigrader/source" export condition) so tests need no prior build.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const conditions = ['@aigrader/source'];

export default defineConfig({
  resolve: {
    conditions,
    alias: {
      'server-only': fileURLToPath(
        new URL('./tests/stubs/server-only.ts', import.meta.url),
      ),
    },
  },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
  },
});
