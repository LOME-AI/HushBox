// @ts-check
import {
  createBaseConfig,
  nodeConfig,
  testConfig,
  playwrightConfig,
  prettierConfig,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  // Playwright + e2e rules. After testConfig so its e2e-scoped
  // overrides (no-restricted-syntax/imports) win for e2e files.
  ...playwrightConfig,
  prettierConfig,
];
