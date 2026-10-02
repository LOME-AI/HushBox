// Programmatic ESLint tests for the shipped no-repo-rooted-fixture-directory
// extension config. The rule suite beside the rule applies the rule under a
// file glob it writes itself, so nothing there reads the one this file ships —
// and that glob is the config's whole scoping contribution, the rule's own
// filename check being the second half of the same answer.
//
// Every fixture is INLINE TEXT. A fixture tree on disk under this directory is
// the exact defect the rule bans, and this file is a `*.test.mjs`, so the rule
// stands over its own suite.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from './no-repo-rooted-fixture-directory.config.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE_ID = 'test-fixtures/no-repo-rooted-fixture-directory';

function createLinter() {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

/**
 * @param {string} code
 * @param {string} filePath
 */
async function fixtureMessages(code, filePath) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

/** Stages a directory at the working directory, which is inside the repository. */
const STAGES_A_REPOSITORY_DIRECTORY =
  "mkdirSync(path.join(process.cwd(), '__test-fixtures-sample__'));\n";

/** The same call rooted where no scanner of this repository reaches. */
const STAGES_A_TEMPORARY_DIRECTORY = "mkdirSync(path.join(tmpdir(), 'sample'));\n";

describe('the shipped no-repo-rooted-fixture-directory config', () => {
  it('reports a repository-rooted directory staged by a test module', async () => {
    const messages = await fixtureMessages(STAGES_A_REPOSITORY_DIRECTORY, 'scripts/sample.test.ts');

    expect(messages.map((message) => message.messageId)).toEqual(['repoRootedFixtureDirectory']);
  });

  it('reports at error severity, the only level it declares', async () => {
    const [message] = await fixtureMessages(
      STAGES_A_REPOSITORY_DIRECTORY,
      'scripts/sample.test.ts'
    );

    expect(message?.severity).toBe(2);
  });

  it('reaches a test module written in `.mjs`, which its file glob admits', async () => {
    const messages = await fixtureMessages(
      STAGES_A_REPOSITORY_DIRECTORY,
      'scripts/sample.test.mjs'
    );

    expect(messages).toHaveLength(1);
  });

  it('reaches the `setup` spelling of a test module', async () => {
    const messages = await fixtureMessages(
      STAGES_A_REPOSITORY_DIRECTORY,
      'scripts/sample.setup.ts'
    );

    expect(messages).toHaveLength(1);
  });

  it('reaches the `spec` spelling of a test module', async () => {
    const messages = await fixtureMessages(STAGES_A_REPOSITORY_DIRECTORY, 'e2e/sample.spec.ts');

    expect(messages).toHaveLength(1);
  });

  it('is silent in a module that is not a test module', async () => {
    expect(await fixtureMessages(STAGES_A_REPOSITORY_DIRECTORY, 'scripts/sample.ts')).toEqual([]);
  });

  it('is silent on a directory staged outside the repository', async () => {
    expect(await fixtureMessages(STAGES_A_TEMPORARY_DIRECTORY, 'scripts/sample.test.ts')).toEqual(
      []
    );
  });
});
