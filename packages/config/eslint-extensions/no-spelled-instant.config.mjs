/**
 * Test-time lint extension: the vendored no-spelled-instant rule.
 *
 * A test spells no instant; it takes one from the shared test-time module.
 * The fact is visible in one file's syntax, so it is a lint rule for the
 * reasons `no-repo-rooted-fixture-directory.config.mjs` records: the
 * architecture layer cannot see `.mjs` test modules or this package, and lint
 * reports in the editor at the keystroke that writes the literal.
 *
 * The rule self-scopes by filename through `test-file-spellings.ts`, so the
 * glob below is a pre-filter and not a second answer to which files are test
 * modules. A test-support module that is not itself a test file is outside it.
 */
import { fileURLToPath } from 'node:url';
import { TEST_FILE_GLOB } from '../test-file-spellings.ts';
import noSpelledInstant from './rules/no-spelled-instant.mjs';

/** Directories whose test files may spell an instant, each with its reason. */
const SPELLED_INSTANT_EXEMPTIONS = [
  {
    directory: fileURLToPath(new URL('../../../scripts/lib/privacy', import.meta.url)),
    reason:
      'The privacy gate detects spelled instants, so its tests hold them as the subject under test.',
  },
];

const testTimePlugin = {
  meta: { name: 'test-time', version: '1.0.0' },
  rules: {
    'no-spelled-instant': noSpelledInstant,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'no-spelled-instant',
    files: [TEST_FILE_GLOB],
    plugins: { 'test-time': testTimePlugin },
    rules: {
      'test-time/no-spelled-instant': ['error', { exemptDirectories: SPELLED_INSTANT_EXEMPTIONS }],
    },
  },
];
