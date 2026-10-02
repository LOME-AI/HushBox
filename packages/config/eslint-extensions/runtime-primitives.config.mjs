/**
 * Runtime-primitives lint extension: the vendored must-use-Result rule and
 * the cockatiel import restriction.
 *
 * Loaded via the eslint-extensions slot (every *.config.mjs here is composed
 * into the shared flat config). Both rules self-scope by ABSOLUTE filename
 * (must-use-result: apps/api/src; no-external-cockatiel: allowed
 * only in apps/api/src/lib/resilience), so the `files` globs below can stay
 * broad and the entries behave identically regardless of which package's
 * eslint.config.js provides the glob base path.
 */
import { fileURLToPath } from 'node:url';
import mustUseResult from './rules/must-use-result.mjs';
import noExternalCockatiel from './rules/no-external-cockatiel.mjs';

// Repo root, derived from this file's location (packages/config/
// eslint-extensions/). Anchors the exemption list below so it can never match
// a lookalike path in another package.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Files where must-use-Result is temporarily off. Every entry discards a
 * Result at a site no assertion consumes, so the rule is right about all of
 * them and the list is a debt, not a policy: it retires file by file as each
 * site starts consuming the Result it drops. Exported so the rule's tests
 * assert against this list rather than a second copy of it.
 *
 * The list is deliberately per-file rather than a `*.test.ts` class skip: a
 * test that drops a Result passes whether the call succeeded or failed, which
 * is the false green the rule exists to prevent, so new test files must stay
 * inside the perimeter.
 */
export const MUST_USE_RESULT_EXEMPT = [
  'apps/api/src/composition/email/account-deleted-email.test.ts',
  'apps/api/src/composition/email/chargeback-lock-email.test.ts',
  'apps/api/src/composition/email/login-lockout-email.test.ts',
  'apps/api/src/composition/email/newsletter-confirmation-email.test.ts',
  'apps/api/src/composition/email/password-changed-email.test.ts',
  'apps/api/src/composition/email/password-reset-email.test.ts',
  'apps/api/src/composition/email/two-factor-disabled-email.test.ts',
  'apps/api/src/composition/email/two-factor-enabled-email.test.ts',
  'apps/api/src/composition/email/verification-email.test.ts',
  'apps/api/src/composition/email/welcome-email.test.ts',
];

const runtimePrimitivesPlugin = {
  meta: { name: 'runtime-primitives', version: '1.0.0' },
  rules: {
    'must-use-result': mustUseResult,
    'no-external-cockatiel': noExternalCockatiel,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'runtime-primitives',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'runtime-primitives': runtimePrimitivesPlugin },
    rules: {
      'runtime-primitives/must-use-result': 'error',
      'runtime-primitives/no-external-cockatiel': 'error',
    },
  },
  {
    // basePath pins the list to the repo root regardless of which package's
    // eslint.config.js consumes this extension. Only must-use-result is
    // turned off; no-external-cockatiel still applies to these files.
    name: 'runtime-primitives-must-use-result-exemption',
    basePath: REPO_ROOT,
    files: MUST_USE_RESULT_EXEMPT,
    rules: {
      'runtime-primitives/must-use-result': 'off',
    },
  },
];
