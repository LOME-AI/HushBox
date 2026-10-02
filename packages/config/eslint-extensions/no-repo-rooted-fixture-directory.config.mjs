/**
 * Fixture-location lint extension: the vendored no-repo-rooted-fixture-directory
 * rule.
 *
 * A test that stages a fixture directory inside the repository races every
 * scanner the repository runs over itself, and the rule module states what that
 * costs. This file records why the check is a lint rule rather than an
 * architecture rule, since both layers were candidates and each documents its
 * own contract.
 *
 * WHAT THE FACT IS. A directory-creating call whose path is rooted at the
 * module's own location or the working directory — visible in one file's
 * syntax, with no import to resolve and no cross-module reasoning to do. That
 * is the whole of what the architecture layer buys over lint: a ts-morph
 * program and a type checker for invariants no single module holds. This
 * invariant is held entirely by the module that breaks it, so the layer's own
 * admission test is not met, and its README says so directly — structural
 * rules ESLint can express live in the lint layer, one mechanism per rule and
 * never both.
 *
 * WHAT THE ARCHITECTURE LAYER CANNOT SEE. Its project is
 * `<workspace>/**\/*.{ts,tsx}` over the workspace patterns
 * `arch/lib/source-scope.ts` declares, and a collection pattern narrows to each
 * package's `src`. So a `.mjs` test module is outside it in every tree, and
 * this very directory is outside it twice over — `packages/config` has no
 * `src`. The rule suites that vendor this layer's own rules stage fixture trees
 * exactly this way, and an architecture rule could not report one of them. A
 * gate blind to part of its own subject is the wrong gate, and the remedy —
 * widening the scanned globs — hands every architecture rule a new file set at
 * once, which is a scope decision rather than a rule.
 *
 * WHERE THE DIAGNOSTIC HAS TO LAND. The pattern is written by hand, one file
 * at a time, and it has been written eleven times; the twelfth arrived while
 * the previous eleven were being removed, by an author with no way to know. A
 * lint rule reports in the editor at the keystroke that creates it and again on
 * every commit and push, and lint fronts the rest of the CI graph. The
 * architecture scan is a separate command over the whole repository, which is
 * the same distance from the author that let the pattern be copied ten times.
 *
 * The rule self-scopes by filename through `test-file-spellings.ts`, so the
 * glob below is a pre-filter and not a second answer to which files are test
 * modules.
 */
import { TEST_FILE_GLOB } from '../test-file-spellings.ts';
import noRepoRootedFixtureDirectory from './rules/no-repo-rooted-fixture-directory.mjs';

const testFixturesPlugin = {
  meta: { name: 'test-fixtures', version: '1.0.0' },
  rules: {
    'no-repo-rooted-fixture-directory': noRepoRootedFixtureDirectory,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'no-repo-rooted-fixture-directory',
    files: [TEST_FILE_GLOB],
    plugins: { 'test-fixtures': testFixturesPlugin },
    rules: {
      'test-fixtures/no-repo-rooted-fixture-directory': 'error',
    },
  },
];
