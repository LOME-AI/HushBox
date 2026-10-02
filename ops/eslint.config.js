// @ts-check
import {
  createBaseConfig,
  nodeConfig,
  testConfig,
  scriptsConfig,
  prettierConfig,
  NO_CONSOLE_RULE,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  ...scriptsConfig,
  {
    // CODE-RULES: `log`/`info`/`debug` are allowed only in CLI entry points, so
    // scriptsConfig's blanket exemption over this tree is withdrawn and handed
    // back one file at a time below. Scoped here rather than in the shared
    // scriptsConfig because no directory separates the two roles the same way
    // across the trees that compose it: `scripts/lib/` holds helpers, while
    // `ops/lib/` holds entry points.
    files: ['**/*.ts'],
    rules: {
      // The base policy itself, imported rather than re-typed: a withdrawal that
      // restated it would enforce a stale console policy over this tree the moment
      // the base one changed, with nothing to notice.
      'no-console': NO_CONSOLE_RULE,
    },
  },
  {
    // Exact paths, never a name shape: every file here is named as an execution
    // target by a checked-in caller — `generate-dispatch-options.ts` by the root
    // `generate:ops-dispatch` script, `resolve-dispatch-script.ts` and
    // `resolve-pr-scripts.ts` by workflow run steps, and `configure-cors.ts` and
    // `reseal-server-keys.ts` each by an `ops/manifest.yml` entry the dispatch
    // workflow resolves and runs. A helper that wants to report progress returns
    // it to one of these. Checked from another package by
    // `packages/config/eslint-config.test.mjs`: each entry must exist, hold no
    // glob metacharacter, and carry that evidence.
    files: [
      'identity/reseal-server-keys.ts',
      'lib/generate-dispatch-options.ts',
      'lib/resolve-dispatch-script.ts',
      'lib/resolve-pr-scripts.ts',
      'r2/configure-cors.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  prettierConfig,
];

export default eslintConfig;
