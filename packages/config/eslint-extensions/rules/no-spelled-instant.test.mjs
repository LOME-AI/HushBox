// Programmatic ESLint tests for the vendored no-spelled-instant rule.
// Deliberately independent of the eslint-extensions loader (the same pattern
// the other rule suites use): the rule is applied directly to fixture code, so
// a result is valid regardless of loader behaviour.
//
// This file is a `*.test.mjs`, so the rule stands over its own suite: every
// offending timestamp below is assembled from fragments at run time and
// appears in no literal this file spells.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import noSpelledInstant from './no-spelled-instant.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const RULE_ID = 'test-time/no-spelled-instant';

const TEST_FILE = 'scripts/sample.test.ts';
const EXEMPT_DIRECTORY = 'scripts/lib/exempt';

const DAY = ['2026', '01', '15'].join('-');
const MIDNIGHT_UTC = [DAY, 'T', '00', ':', '00', ':', '00', '.000Z'].join('');
const AFTERNOON = [DAY, 'T', '14', ':', '30', ':', '45', 'Z'].join('');
const OFFSET = [DAY, 'T', '09', ':', '00', ':', '00', '+05', ':', '30'].join('');
const MINUTES_ONLY = [DAY, 'T', '09', ':', '00'].join('');

/** @type {import('eslint').Linter.Config[]} */
const ruleConfig = [
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'test-time': {
        meta: { name: 'test-time', version: '1.0.0' },
        rules: { 'no-spelled-instant': noSpelledInstant },
      },
    },
    rules: {
      [RULE_ID]: [
        'error',
        {
          exemptDirectories: [
            {
              directory: path.join(REPO_ROOT, ...EXEMPT_DIRECTORY.split('/')),
              reason: 'a fixture exemption for this suite',
            },
          ],
        },
      ],
    },
  },
];

/**
 * @param {string} code
 * @param {string} filePath
 */
async function lintAtPath(code, filePath = TEST_FILE) {
  const linter = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: ruleConfig,
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(REPO_ROOT, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

describe('no-spelled-instant', () => {
  it('applies when its config declares no exemptions', async () => {
    const linter = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: [{ ...ruleConfig[0], rules: { [RULE_ID]: 'error' } }],
    });
    const [result] = await linter.lintText(`const at = '${AFTERNOON}';\n`, {
      filePath: path.join(REPO_ROOT, 'scripts', 'sample.test.ts'),
    });
    expect(result?.messages.filter((message) => message.ruleId === RULE_ID)).toHaveLength(1);
  });

  it('flags a string literal spelling a UTC-midnight instant', async () => {
    expect(await lintAtPath(`const at = '${MIDNIGHT_UTC}';\n`)).toHaveLength(1);
  });

  it('flags an instant at a time of day other than midnight', async () => {
    expect(await lintAtPath(`const at = '${AFTERNOON}';\n`)).toHaveLength(1);
  });

  it('flags an instant written with a numeric offset', async () => {
    expect(await lintAtPath(`const at = '${OFFSET}';\n`)).toHaveLength(1);
  });

  it('flags an instant carrying hours and minutes only', async () => {
    expect(await lintAtPath(`const at = '${MINUTES_ONLY}';\n`)).toHaveLength(1);
  });

  it('flags an instant embedded in a longer string', async () => {
    expect(await lintAtPath(`const line = 'created ${AFTERNOON} by the seed';\n`)).toHaveLength(1);
  });

  it('flags an instant spelled inside a template literal', async () => {
    const code = `const id = 7;\nconst line = \`row \${id} at ${AFTERNOON}\`;\n`;
    expect(await lintAtPath(code)).toHaveLength(1);
  });

  it('flags an instant spelled as a string literal type', async () => {
    expect(await lintAtPath(`type At = '${MIDNIGHT_UTC}';\n`)).toHaveLength(1);
  });

  it('flags an instant spelled as JSX text', async () => {
    const code = `const node = <time>${AFTERNOON}</time>;\n`;
    expect(await lintAtPath(code, 'apps/web/src/sample.test.tsx')).toHaveLength(1);
  });

  it('reports every spelled instant in a file, not only the first', async () => {
    const code = `const a = '${MIDNIGHT_UTC}';\nconst b = '${AFTERNOON}';\n`;
    expect(await lintAtPath(code)).toHaveLength(2);
  });

  it('reports at the literal that spells the instant', async () => {
    const [message] = await lintAtPath(`const a = 1;\nconst at = '${AFTERNOON}';\n`);
    expect(message?.line).toBe(2);
    expect(message?.column).toBe(12);
  });

  it('names the test-time module for test files', async () => {
    const [message] = await lintAtPath(`const at = '${AFTERNOON}';\n`);
    expect(message?.message).toContain('@hushbox/shared/test-time');
  });

  it('names the runner-free instants module for modules that cannot load the runner', async () => {
    const [message] = await lintAtPath(`const at = '${AFTERNOON}';\n`);
    expect(message?.message).toContain('@hushbox/shared/test-instants');
  });

  it('leaves a bare calendar date alone', async () => {
    expect(await lintAtPath(`const day = '${DAY}';\n`)).toEqual([]);
  });

  it('leaves an instant obtained from the test-time module alone', async () => {
    const code =
      "import { isoAt, TEST_DAY_START } from '@hushbox/shared/test-time';\nconst at = isoAt(TEST_DAY_START);\n";
    expect(await lintAtPath(code)).toEqual([]);
  });

  it('leaves a module that is not a test file alone', async () => {
    expect(await lintAtPath(`const at = '${AFTERNOON}';\n`, 'scripts/sample.ts')).toEqual([]);
  });

  it('reaches the setup spelling of a test module', async () => {
    expect(
      await lintAtPath(`const at = '${AFTERNOON}';\n`, 'scripts/sample.setup.ts')
    ).toHaveLength(1);
  });

  it('leaves a test file under an exempt directory alone', async () => {
    const filePath = `${EXEMPT_DIRECTORY}/sample.test.ts`;
    expect(await lintAtPath(`const at = '${AFTERNOON}';\n`, filePath)).toEqual([]);
  });

  it('reaches a test file whose directory only shares a prefix with an exempt one', async () => {
    const filePath = `${EXEMPT_DIRECTORY}-sibling/sample.test.ts`;
    expect(await lintAtPath(`const at = '${AFTERNOON}';\n`, filePath)).toHaveLength(1);
  });
});
