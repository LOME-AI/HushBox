/**
 * Environment-detection lint extension: the vendored no-direct-env-branch rule.
 *
 * A branch asks `envUtils` (from `createEnvUtilities()`) which mode it is in;
 * `NODE_ENV`, `CI` and `E2E` are read inside that classifier and nowhere else
 * (`docs/CODE-RULES.md` §Environment Detection).
 *
 * The rule self-scopes by ABSOLUTE filename to `apps/*|packages/*` source
 * trees, so the broad `files` glob below behaves identically regardless of
 * which package's eslint.config.js provides the glob base path.
 */
import noDirectEnvBranch from './rules/no-direct-env-branch.mjs';

const envDetectionPlugin = {
  meta: { name: 'env-detection', version: '1.0.0' },
  rules: {
    'no-direct-env-branch': noDirectEnvBranch,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'env-detection',
    // `.astro` is in scope deliberately: a template branches on the environment
    // as readily as a module does, and the doctrine is about the branch, not the
    // file type.
    files: ['**/*.ts', '**/*.tsx', '**/*.astro'],
    plugins: { 'env-detection': envDetectionPlugin },
    rules: {
      'env-detection/no-direct-env-branch': 'error',
    },
  },
];
