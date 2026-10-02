/**
 * Vacuous-assertion lint extension: the vendored no-raw-function-type-assertion
 * rule.
 *
 * A test that asserts only "this is a function" passes whatever the code under
 * it does, so a test named for a branch, an implementation or a selection keeps
 * its green light when that wiring is inverted. The repository's legitimate
 * uses of the shape now wear names — `expectExposes` for a shape contract,
 * `expectCompileTimeProof` for a `@ts-expect-error`-backed site — which is
 * precisely what lets this ban carry NO exemption or allowlist mechanism: with
 * both honest uses spelled by name, a raw spelling left in a test is by
 * construction a site nobody classified. A site that seems to need an exemption
 * is a migration that is not finished.
 *
 * Scoped to test files only, through the same `TEST_FILE_GLOB` the base config's
 * test relaxations use, so the one answer to "is this a test module" governs
 * here too. Production code is out of scope by design: outside a test, a
 * function-type check is ordinary runtime narrowing rather than an assertion
 * standing in for a claim.
 */
import { TEST_FILE_GLOB } from '../test-file-spellings.ts';
import noRawFunctionTypeAssertion from './rules/no-raw-function-type-assertion.mjs';

const vacuityPlugin = {
  meta: { name: 'vacuity', version: '1.0.0' },
  rules: {
    'no-raw-function-type-assertion': noRawFunctionTypeAssertion,
  },
};

/**
 * `load-extensions.mjs` discovers every `*.config.mjs` in this directory by
 * name and reads its default export; there is no index and no registration
 * step, so nothing here is reached by an import from the lint gate's side.
 */
/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'no-raw-function-type-assertion',
    files: [TEST_FILE_GLOB],
    plugins: { vacuity: vacuityPlugin },
    rules: {
      'vacuity/no-raw-function-type-assertion': 'error',
    },
  },
];
