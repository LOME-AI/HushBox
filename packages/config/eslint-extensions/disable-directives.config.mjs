/**
 * Suppression-reason lint extension: the vendored require-reason rule.
 *
 * A suppression is a claim that a rule is wrong here, and a claim nobody wrote
 * down cannot be reviewed, revisited or retired — the next reader can only
 * guess whether the rule still has nothing to say about the line beneath it.
 * ESLint's own `reportUnusedDisableDirectives` already refuses a directive that
 * suppresses nothing; this refuses one that explains nothing.
 *
 * Reasons are written in ESLint's own ` -- ` form, so the text the rule demands
 * is the text ESLint already parses as the directive's description rather than
 * a convention of ours layered on top.
 *
 * Wherever suppressions are written, so the broad `files` globs are correct
 * under any package's glob base path. `.astro` is absent because the astro
 * parser owns its own comment syntax, and `.js`/`.cjs` because the repo's
 * hand-written sources in those spellings are tool configuration the base
 * config already exempts.
 *
 * A generated file is excluded by path: its blanket directive is written by the
 * generator, and the remedy a reason would ask for is a change to code nobody
 * edits by hand.
 */
import requireDisableReason from './rules/require-disable-reason.mjs';

const disableDirectivesPlugin = {
  meta: { name: 'disable-directives', version: '1.0.0' },
  rules: {
    'require-reason': requireDisableReason,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'disable-directives',
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
    ignores: ['**/routeTree.gen.ts'],
    plugins: { 'disable-directives': disableDirectivesPlugin },
    rules: {
      'disable-directives/require-reason': 'error',
    },
  },
];
