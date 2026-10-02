// Programmatic ESLint tests for the shipped no-spelled-instant extension
// config. The rule suite beside the rule writes its own file glob and its own
// exemption, so nothing there reads the ones this file ships.
//
// This file is a `*.test.mjs`, so the rule stands over it: the offending
// timestamp is assembled from fragments at run time.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from './no-spelled-instant.config.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE_ID = 'test-time/no-spelled-instant';

const SPELLS_AN_INSTANT = `const at = '${['2026-01-15', 'T', '14', ':', '30', ':', '45', 'Z'].join('')}';\n`;

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

/** @param {string} filePath */
async function messagesAt(filePath) {
  const [result] = await createLinter().lintText(SPELLS_AN_INSTANT, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

describe('the shipped no-spelled-instant config', () => {
  it('reports an instant spelled in a test module', async () => {
    const messages = await messagesAt('apps/api/src/sample.test.ts');

    expect(messages.map((message) => message.messageId)).toEqual(['spelledInstant']);
  });

  it('reports at error severity', async () => {
    const [message] = await messagesAt('apps/api/src/sample.test.ts');

    expect(message?.severity).toBe(2);
  });

  it('leaves a module that is not a test file alone', async () => {
    expect(await messagesAt('apps/api/src/sample.ts')).toEqual([]);
  });

  it("admits the privacy gate's own tests, whose subject is a spelled instant", async () => {
    expect(await messagesAt('scripts/lib/privacy/sample.test.ts')).toEqual([]);
  });

  it('reaches a test module beside the privacy gate rather than inside it', async () => {
    expect(await messagesAt('scripts/lib/sample.test.ts')).toHaveLength(1);
  });
});
