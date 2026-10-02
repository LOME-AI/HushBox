/**
 * Rate-limit lint extension: the two prohibitions that are local enough for
 * ESLint to see — the retired `{count, firstAttempt}` window shape, and a
 * limiter that admits on failure. The rest of the wall (which key definitions
 * may drive a `ratelimit:` counter, where event counting may live, and the
 * read-then-write gate) needs whole-function and cross-file structure, so it
 * lives in the ts-morph arch layer instead; one mechanism per rule, never both.
 *
 * Both rules self-scope by ABSOLUTE filename (apps/api/src), so the `files`
 * glob below can stay broad and the entry behaves identically regardless of
 * which package's eslint.config.js provides the glob base path.
 */
import failsClosed from './rules/rate-limit-fails-closed.mjs';
import noWindowCounterShape from './rules/no-window-counter-shape.mjs';

const rateLimitPlugin = {
  meta: { name: 'rate-limit', version: '1.0.0' },
  rules: {
    'fails-closed': failsClosed,
    'no-window-counter-shape': noWindowCounterShape,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'rate-limit',
    files: ['**/*.ts'],
    plugins: { 'rate-limit': rateLimitPlugin },
    rules: {
      'rate-limit/fails-closed': 'error',
      'rate-limit/no-window-counter-shape': 'error',
    },
  },
];
