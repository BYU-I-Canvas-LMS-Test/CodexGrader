// Vitest resolves sibling workspace packages from their TypeScript SOURCE
// (the "@aigrader/source" export condition) so tests never depend on a
// prior `tsc` build of dist/. Production Node resolves the "import"
// condition (built dist/) as usual.

import { defineConfig } from 'vitest/config';

const conditions = ['@aigrader/source'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    environment: 'node',
  },
});
