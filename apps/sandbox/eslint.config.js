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
  {
    // `public/render.js` and `public/python.js` are the generated, minified
    // renderer/runtime bundles (built from src/render and src/python by
    // `build:render`/`build:python`); they are build outputs, not authored source.
    ignores: ['dist', 'public/pyodide', 'public/render.js', 'public/python.js'],
  },
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  ...scriptsConfig,
  {
    // CODE-RULES: `log`/`info`/`debug` are allowed only in CLI entry points, so
    // scriptsConfig's blanket exemption over this tree is withdrawn and handed
    // back one file at a time below. It matters more here than in a tooling
    // tree: whatever `public/render.js` and `public/python.js` are bundled from
    // reaches the public sandbox origin, where a stray print is a disclosure
    // surface rather than noise. Directory is no guide to which files those are:
    // the build scripts that produce those two bundles sit under
    // `apps/sandbox/src/render`/`apps/sandbox/src/python` themselves and are in neither.
    files: ['**/*.ts'],
    rules: {
      // The base policy itself, imported rather than re-typed: a withdrawal that
      // restated it would enforce a stale console policy over this tree the moment
      // the base one changed, with nothing to notice.
      'no-console': NO_CONSOLE_RULE,
    },
  },
  {
    // Exact paths, never a name shape: each of these is a package script target
    // (`build`, `build:python`, `build:render`, `dev`) printing its own terminal
    // output — a completion line for the three builds, a listen line for the dev
    // server — and none of them is bundled. Checked from another package by
    // `packages/config/eslint-config.test.mjs`: each entry must exist, hold no glob
    // metacharacter, and be named as an execution target by a checked-in caller.
    files: [
      'src/build.ts',
      'src/python/build-python-bundle.ts',
      'src/render/build-bundle.ts',
      'src/serve.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  prettierConfig,
];

export default eslintConfig;
