/**
 * Comment cross-reference lint extension: the vendored
 * resolvable-cross-reference rule.
 *
 * A cross-reference in a comment names its target through a form that resolves
 * — a `{@link}` tag naming a symbol, a backticked path for a file — so that
 * an editor can follow it and a rule can check it. That discipline exists to
 * keep citations naming a thing rather than a position, and a discipline
 * nothing checks is a discipline that decays. This is the check.
 *
 * The rule applies wherever comments are written, so the broad `files` globs
 * are correct under any package's glob base path. `.astro` is absent because
 * the astro parser owns its own comment syntax.
 *
 * What the path form admits is decided by `isPathToken` in
 * `packages/config/eslint-extensions/rules/resolvable-cross-reference.mjs`, and
 * `isPathToken`'s docstring records the reasons and what they cost. What
 * happens when git cannot be read is documented in the same file, in the bodies
 * of `readTrackedTree`, `readRootFileHistory` and the rule's `create`.
 */
import resolvableCrossReference from './rules/resolvable-cross-reference.mjs';

const commentsPlugin = {
  meta: { name: 'comments', version: '1.0.0' },
  rules: {
    'resolvable-cross-reference': resolvableCrossReference,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'cross-references',
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    plugins: { comments: commentsPlugin },
    rules: {
      'comments/resolvable-cross-reference': ['error', { forms: ['symbol', 'path'] }],
    },
  },
];
