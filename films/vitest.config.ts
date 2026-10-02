import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

/**
 * The package's test config. The `test` script omits `--passWithNoTests`: a run
 * collecting zero tests is a regression that must fail loudly.
 *
 * Coverage is claimed by existence: every `.ts` module under the package is in
 * the gate unless it is one of the kinds excluded below. A `*.driver.ts` module
 * needs a browser, the renderer or ffmpeg, and `.tsx` compositions render video
 * frames; both are proven by the render gates rather than by units.
 *
 * Look code is outside unit coverage by the founder's ruling: a take under a
 * film's `rounds/` is outside every package gate, tests included, and every
 * module of a film's directory but its `film.ts` (its look, however many files
 * it spans, and its score) is proven by verify's render and audio checks and by
 * its byte match with the approved take. A film's directory is named
 * `YYYY-MM-slug`; its `film.ts` keeps unit coverage.
 *
 * The test runners load this file by path, so no module imports it.
 * @toolContract
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      name: 'films',
      environment: 'node',
      // Appended to the root setup list, not replacing it.
      setupFiles: ['@hushbox/shared/property-tests.setup'],
      // Appended to the root exclude list, not replacing it.
      exclude: ['*/rounds/**'],
      coverage: {
        include: ['**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/*.tsx',
          '**/*.driver.ts',
          '*.config.ts',
          'src/**',
          'engine/fixtures/**',
          '*/rounds/**',
          '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*/!(film).ts',
        ],
        thresholds: {
          perFile: true,
          lines: 95,
          branches: 95,
          functions: 95,
          statements: 95,
        },
      },
    },
  })
);
