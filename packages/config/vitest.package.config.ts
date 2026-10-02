import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from './vitest.config.js';

/**
 * Test config for THIS package's own tooling tests (loader, lint-rule
 * fixtures, arch harness). Separate from vitest.config.ts, which is the
 * shared root config exported to every other package — giving it
 * package-local coverage scoping would leak into all of them.
 *
 * `scripts/lib/test-run/test-packages.ts` picks this file by name and passes it to
 * vitest's `--config`, so no module imports it.
 * @toolContract
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      name: 'config',
      environment: 'node',
      coverage: {
        // The CLI entry (arch/run.ts) is a thin wrapper over these tested
        // modules and is verified end-to-end in CI by actually running it.
        include: [
          'behaviour-ledger.mjs',
          'eslint-extensions/load-extensions.mjs',
          'eslint-extensions/rules/*.mjs',
          'arch/lib/**/*.ts',
          'arch/rules/*.rule.ts',
          'rule-named-paths.mjs',
          'test-file-spellings.ts',
        ],
      },
    },
  })
);
