// Programmatic ESLint tests for the shipped no-star-exports extension config.
// The rule suite beside the rule applies the rule directly under fixture
// options, so nothing there reads what this file ships: the scope directory,
// the exemption list and the plugin wiring answer only when the config itself
// is the configuration. Paths are synthetic but rooted at the real repository,
// because the scope test and the exemption match both read an absolute
// filename, and the star targets are real modules because the rule decides
// leaf-versus-barrel by reading the target.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from './no-star-exports.config.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE_ID = 'barrel/no-star-exports';

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
async function starMessages(code, filePath) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

/** A star into a leaf that sits outside the subtree the exemptions protect. */
const STARS_A_LEAF = "export * from './constants.ts';\n";

/** The same shape, aimed into the money layer the third exemption re-gates. */
const STARS_THE_MONEY_LAYER = "export * from './affordability/constants.ts';\n";

describe('the shipped no-star-exports config', () => {
  it('reports a star into a leaf inside the scope directory it ships', async () => {
    const messages = await starMessages(STARS_A_LEAF, 'packages/shared/src/sample.ts');

    expect(messages.map((message) => message.messageId)).toEqual(['starIntoLeaf']);
  });

  it('reports at error severity, the only level it declares', async () => {
    const [message] = await starMessages(STARS_A_LEAF, 'packages/shared/src/sample.ts');

    expect(message?.severity).toBe(2);
  });

  it('is silent on the same star outside that scope directory', async () => {
    expect(await starMessages(STARS_A_LEAF, 'packages/ui/src/sample.ts')).toEqual([]);
  });

  it('governs a `.tsx` module, which its file glob admits beside `.ts`', async () => {
    expect(await starMessages(STARS_A_LEAF, 'packages/shared/src/sample.tsx')).toHaveLength(1);
  });

  it('lets the shipped exemption cover the root barrel it names', async () => {
    expect(await starMessages(STARS_A_LEAF, 'packages/shared/src/index.ts')).toEqual([]);
  });

  it('keeps the money layer gated at that same exempted root barrel', async () => {
    const messages = await starMessages(STARS_THE_MONEY_LAYER, 'packages/shared/src/index.ts');

    expect(messages.map((message) => message.messageId)).toEqual(['starIntoLeaf']);
  });
});
