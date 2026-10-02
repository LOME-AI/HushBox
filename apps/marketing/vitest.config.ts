import { defineConfig, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import rootConfig, { BROWSER_TEST_ENVIRONMENT } from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

export default mergeConfig(
  rootConfig,
  // defineConfig (not defineProject) because the coverage gate below is a
  // root-level key; the standalone `vitest run --coverage` invocation reads it.
  defineConfig({
    plugins: [react()],
    test: {
      name: 'marketing',
      environment: BROWSER_TEST_ENVIRONMENT,
      globals: true,
      setupFiles: ['./src/test.setup.ts'],
      coverage: {
        // Static inclusion over the real vitest-testable product source: the v8
        // provider only reports files some test imported, so without `include` a
        // never-imported island (e.g. a legal-document component) passes the gate
        // silently. With it, vitest merges unimported matches into the report at
        // 0% and the per-file thresholds below see them. Root-config excludes
        // still apply after `include`; what they release is stated at each of
        // that list's own entries.
        // `scripts/**` alongside the site source: the marketing build's own
        // tooling is product code that ships nothing to a browser but decides
        // what the beacon may count, and outside this list it would be
        // measured against no threshold at all.
        include: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
        exclude: [
          // What cannot be measured here is a module whose import graph reaches
          // an `astro:*` virtual specifier, which resolves only in the Astro
          // build. Vitest resolves no such protocol, so a test importing one
          // dies on the specifier — while coverage `include` still merges the
          // never-imported file into the report at 0%. Measured, such a file
          // fails the per-file gate with no way back: the only thing that could
          // raise its number is the import that cannot resolve. Every entry
          // below is one, named individually so that a sibling free of the
          // dependency is measured rather than released by the directory it
          // sits in. Their logic is factored into modules without the
          // dependency, covered there, leaving the excluded file a wiring
          // shell the Astro build exercises. The `.astro` templates need no
          // entry at all: the `.ts`/`.tsx` include above never matches one.
          'src/pages/rss.xml.ts',
          'src/pages/blog-index.json.ts',
          'src/lib/blog.ts',
          'src/content.config.ts',
        ],
        thresholds: {
          'src/**/*.{ts,tsx}': COVERAGE_GATE,
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, './src'),
      },
    },
  })
);
