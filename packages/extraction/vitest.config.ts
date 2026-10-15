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
    // The first test in each file to touch a PDF pays pdf.js's cold import
    // (the HEIC tests likewise load libheif): well under a second locally,
    // but 9–12s on a busy Windows CI runner — past the 5s default.
    testTimeout: 30_000,
  },
});
