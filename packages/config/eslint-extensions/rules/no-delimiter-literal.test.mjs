// Programmatic ESLint tests for the vendored no-delimiter-literal rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to fixture
// code, so these tests stay valid regardless of loader behavior.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../assistant-text.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const GRAMMAR = 'packages/shared/src/assistant-text/grammar.ts';
const GRAMMAR_TEST = 'packages/shared/src/assistant-text/grammar.test.ts';

// Fixture sources spell the record separator as an escape, so this file never
// holds the character itself.
const RECORD_SEPARATOR_SOURCE = String.raw`'\u001E'`;

const MESSAGES = {
  open: 'The <think> delimiter belongs to packages/shared/src/assistant-text/grammar.ts alone. Build or parse assistant text through its exported API, never by writing the delimiter.',
  close:
    'The </think> delimiter belongs to packages/shared/src/assistant-text/grammar.ts alone. Build or parse assistant text through its exported API, never by writing the delimiter.',
  recordSeparator:
    'The record separator (U+001E) delimiter belongs to packages/shared/src/assistant-text/grammar.ts alone. Build or parse assistant text through its exported API, never by writing the delimiter.',
};

function createLinter() {
  return new ESLint({
    cwd: here,
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
async function lintAtPath(code, filePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...filePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages
    .filter((m) => m.ruleId === 'assistant-text/no-delimiter-literal')
    .map((m) => m.message);
}

describe('no-delimiter-literal', () => {
  it('flags a string literal carrying the think open tag, naming it', async () => {
    expect(await lintAtPath("const s = '<think>';\n", 'apps/web/src/lib/anywhere.ts')).toEqual([
      MESSAGES.open,
    ]);
  });

  it('flags a string literal carrying the think close tag, naming it', async () => {
    expect(
      await lintAtPath("const s = '</think>';\n", 'apps/api/src/slices/chat/domain/x.ts')
    ).toEqual([MESSAGES.close]);
  });

  it('flags a string literal carrying the record separator, naming it', async () => {
    expect(
      await lintAtPath(`const s = ${RECORD_SEPARATOR_SOURCE};\n`, 'packages/shared/src/x.ts')
    ).toEqual([MESSAGES.recordSeparator]);
  });

  it('flags the record separator inside a template literal', async () => {
    expect(
      await lintAtPath('const s = `a\\u001E${String(1)}`;\n', 'apps/web/src/components/x.tsx')
    ).toEqual([MESSAGES.recordSeparator]);
  });

  it('flags a delimiter embedded inside a larger string once per literal', async () => {
    expect(
      await lintAtPath(
        "const s = 'prefix <think>thoughts</think> answer';\n",
        'packages/shared/src/anywhere.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a delimiter in a tagged template whose escape sequence has no cooked value', async () => {
    expect(
      await lintAtPath('const s = tag`\\unicode <think>`;\n', 'apps/web/src/lib/tagged.ts')
    ).toEqual([MESSAGES.open]);
  });

  const OPEN_SOURCE = "const s = '<think>';\n";
  const CLOSE_SOURCE = "const s = '</think>';\n";
  const RS_SOURCE = `const s = ${RECORD_SEPARATOR_SOURCE};\n`;

  const EVERY_DELIMITER_FILES = [
    GRAMMAR,
    GRAMMAR_TEST,
    'packages/shared/src/assistant-text/grammar.property.test.ts',
    'packages/shared/src/assistant-text/reducer.property.test.ts',
  ];

  it.each(EVERY_DELIMITER_FILES.map((file) => [file]))(
    'allows every delimiter in %s',
    async (file) => {
      expect(await lintAtPath(OPEN_SOURCE, file)).toEqual([]);
      expect(await lintAtPath(CLOSE_SOURCE, file)).toEqual([]);
      expect(await lintAtPath(RS_SOURCE, file)).toEqual([]);
    }
  );

  it.each([
    ['packages/shared/src/reasoning-format.ts'],
    ['packages/shared/src/reasoning-format.test.ts'],
  ])('keeps no exemption for the retired inline reasoning module at %s', async (file) => {
    expect(await lintAtPath(OPEN_SOURCE, file)).toEqual([MESSAGES.open]);
    expect(await lintAtPath(CLOSE_SOURCE, file)).toEqual([MESSAGES.close]);
    expect(await lintAtPath(RS_SOURCE, file)).toEqual([MESSAGES.recordSeparator]);
  });

  it('allows only the record separator in the legal copy digest, which separates legal copy', async () => {
    const file = 'packages/shared/src/legal/copy-digest.ts';
    expect(await lintAtPath(RS_SOURCE, file)).toEqual([]);
    expect(await lintAtPath(OPEN_SOURCE, file)).toEqual([MESSAGES.open]);
    expect(await lintAtPath(CLOSE_SOURCE, file)).toEqual([MESSAGES.close]);
  });

  it('reports a delimiter a file may not hold even beside one it may', async () => {
    expect(
      await lintAtPath(
        `const s = ${RECORD_SEPARATOR_SOURCE} + '<think>';\nconst t = '\\u001E</think>';\n`,
        'packages/shared/src/legal/copy-digest.ts'
      )
    ).toEqual([MESSAGES.open, MESSAGES.close]);
  });

  it('does not exempt look-alike filenames elsewhere', async () => {
    expect(
      await lintAtPath(`const s = ${RECORD_SEPARATOR_SOURCE};\n`, 'apps/web/src/lib/grammar.ts')
    ).toHaveLength(1);
  });

  it('allows strings that merely mention think without a delimiter', async () => {
    expect(
      await lintAtPath(
        "const a = 'think'; const b = 'thinking...'; const c = '<thinking>';\n",
        'apps/web/src/lib/clean.ts'
      )
    ).toEqual([]);
  });

  it('allows the unit separator, which frames nothing on its own', async () => {
    expect(
      await lintAtPath(String.raw`const s = '\u001F';` + '\n', 'packages/shared/src/x.ts')
    ).toEqual([]);
  });

  it('ignores comments (the ban is on string values that could write the format)', async () => {
    expect(
      await lintAtPath(
        "// a raw value starting '<think>' resolves nowhere\nconst ok = 1;\n",
        'apps/api/src/slices/workflows/nodes/y.ts'
      )
    ).toEqual([]);
  });
});
