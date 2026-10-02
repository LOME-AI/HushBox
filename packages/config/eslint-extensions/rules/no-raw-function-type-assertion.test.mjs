// Programmatic ESLint tests for the vendored no-raw-function-type-assertion
// rule. Same pattern as the other rule suites: the rule is applied to a fixture
// tree through a hand-built flat config, so the TEST_FILE_GLOB scoping the
// shipped topic config uses is exercised exactly as it runs in the real config.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import noRawFunctionTypeAssertion from './no-raw-function-type-assertion.mjs';
import { TEST_FILE_GLOB } from '../../test-file-spellings.ts';
import { loadEslintExtensions } from '../load-extensions.mjs';
import topicConfig from '../no-raw-function-type-assertion.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__test-fixtures-no-raw-function-type-assertion__');

const RULE_KEY = 'vacuity/no-raw-function-type-assertion';

/**
 * Lints one fixture and returns this rule's messages for it.
 *
 * Both throws are load-bearing rather than defensive: every negative case below
 * asserts an EMPTY message list, and a mistyped fixture name, an unparseable
 * fixture or a fixture no config entry matches would each satisfy that by
 * linting nothing at all — the vacuous green this whole rule exists to ban.
 * @param {string} file
 */
async function lint(file) {
  const fixture = path.join(fixturesDir, file);
  if (!existsSync(fixture)) throw new Error(`no such fixture: ${file}`);
  const linter = new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      {
        files: [TEST_FILE_GLOB],
        plugins: {
          vacuity: {
            meta: { name: 'vacuity' },
            rules: { 'no-raw-function-type-assertion': noRawFunctionTypeAssertion },
          },
        },
        rules: { [RULE_KEY]: 'error' },
      },
    ],
  });
  const [result] = await linter.lintFiles([fixture]);
  if (result === undefined) throw new Error('ESLint returned no lint result');
  const fileLevel = result.messages.find((message) => message.ruleId === null);
  if (fileLevel !== undefined) throw new Error(`${file}: ${fileLevel.message}`);
  return result.messages.filter((message) => message.ruleId === RULE_KEY);
}

/** The lines this rule reported in one fixture. @param {string} file */
async function reportedLines(file) {
  const messages = await lint(file);

  return messages.map((message) => message.line);
}

describe('no-raw-function-type-assertion', () => {
  it('reports the single-quoted typeof spelling', async () => {
    expect(await reportedLines('banned.test.ts')).toContain(1);
  });

  it('reports the double-quoted typeof spelling', async () => {
    expect(await reportedLines('banned.test.ts')).toContain(2);
  });

  it('reports the toBeTypeOf spelling', async () => {
    expect(await reportedLines('banned.test.ts')).toContain(3);
  });

  it('reports the toBeInstanceOf(Function) spelling', async () => {
    expect(await reportedLines('banned.test.ts')).toContain(4);
  });

  it('reports every banned spelling in the fixture and nothing else', async () => {
    expect(await reportedLines('banned.test.ts')).toEqual([1, 2, 3, 4]);
  });
});

describe('the ban is by meaning, not by the surveyed spellings', () => {
  it('reports a typeof compared with toEqual', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).toContain(1);
  });

  it('reports a typeof compared with toStrictEqual', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).toContain(2);
  });

  it('reports a template-literal argument carrying no substitution', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).toContain(3);
  });

  it('reports the global Function reached through globalThis', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).toContain(4);
  });

  it('reports a typeof comparison asserted for truth', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).toContain(5);
  });

  it('reports through a resolves chain', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).toContain(7);
  });

  it('reports a soft expectation', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).toContain(8);
  });
});

describe('what the ban leaves alone', () => {
  it('leaves the same spellings alone outside a test file', async () => {
    expect(await lint('not-a-test-file.ts')).toEqual([]);
  });

  it('leaves a bare expectExposes call alone', async () => {
    expect(await lint('named-helpers.test.ts')).toEqual([]);
  });

  it('leaves a bare expectCompileTimeProof call alone', async () => {
    expect(await lint('named-helpers.test.ts')).toEqual([]);
  });

  it('leaves a typeof predicate inside a callback alone', async () => {
    expect(await reportedLines('legitimate.test.ts')).not.toContain(1);
  });

  it('leaves an expect.any(Function) argument matcher alone', async () => {
    expect(await reportedLines('legitimate.test.ts')).not.toContain(2);
  });

  it('leaves an assertion about a non-function type alone', async () => {
    expect(await reportedLines('legitimate.test.ts')).not.toContain(3);
  });

  it('leaves an instance assertion against another constructor alone', async () => {
    expect(await reportedLines('legitimate.test.ts')).not.toContain(4);
  });
});

describe('a negative claim is falsifiable, so the ban leaves it alone', () => {
  it('leaves a negated typeof equality alone', async () => {
    expect(await reportedLines('negation.test.ts')).not.toContain(1);
  });

  it('leaves a negated toBeTypeOf alone', async () => {
    expect(await reportedLines('negation.test.ts')).not.toContain(2);
  });

  it('leaves a negated instance assertion alone', async () => {
    expect(await reportedLines('negation.test.ts')).not.toContain(3);
  });

  it('leaves a typeof comparison asserted false alone', async () => {
    expect(await reportedLines('negation.test.ts')).not.toContain(4);
  });

  it('leaves an inequality comparison asserted true alone', async () => {
    expect(await reportedLines('negation.test.ts')).not.toContain(5);
  });

  it('leaves a typeof comparison asserted falsy alone', async () => {
    expect(await reportedLines('negation.test.ts')).not.toContain(6);
  });

  it('reports an inequality comparison asserted false, which claims function-ness', async () => {
    expect(await reportedLines('negation.test.ts')).toContain(7);
  });

  it('reports a typeof comparison asserted truthy', async () => {
    expect(await reportedLines('negation.test.ts')).toContain(8);
  });

  it('leaves a comparison asserted against neither truth value alone', async () => {
    expect(await reportedLines('negation.test.ts')).not.toContain(9);
  });

  it('reports a doubly negated comparison, which claims function-ness again', async () => {
    expect(await reportedLines('negation.test.ts')).toContain(10);
  });

  it('leaves the negated spelling in the by-meaning fixture alone', async () => {
    expect(await reportedLines('banned-by-meaning.test.ts')).not.toContain(6);
  });
});

describe('reading polarity stops where the claim stops', () => {
  it('leaves an identity comparison that is not about a type alone', async () => {
    expect(await reportedLines('polarity-edges.test.ts')).not.toContain(1);
  });

  it('leaves a comparison asserted through a matcher carrying no truth value alone', async () => {
    expect(await reportedLines('polarity-edges.test.ts')).not.toContain(2);
  });

  it('leaves a comparison asserted against a variable alone', async () => {
    expect(await reportedLines('polarity-edges.test.ts')).not.toContain(3);
  });
});

describe('expect.any(Function) is the same claim in another spelling', () => {
  it('reports it as the whole argument of toEqual', async () => {
    expect(await reportedLines('any-function.test.ts')).toContain(1);
  });

  it('reports it as the whole argument of toStrictEqual', async () => {
    expect(await reportedLines('any-function.test.ts')).toContain(2);
  });

  it('leaves it alone inside a structural shape, where it is one field among others', async () => {
    expect(await reportedLines('any-function.test.ts')).not.toContain(3);
  });

  it('leaves it alone as a call-argument matcher', async () => {
    expect(await reportedLines('any-function.test.ts')).not.toContain(4);
  });

  it('leaves a negated one alone', async () => {
    expect(await reportedLines('any-function.test.ts')).not.toContain(5);
  });

  it('leaves expect.any of another constructor alone', async () => {
    expect(await reportedLines('any-function.test.ts')).not.toContain(6);
  });
});

describe('shapes at the edge of the ban', () => {
  it('survives a matcher called with no argument at all', async () => {
    expect(await reportedLines('edge-shapes.test.ts')).not.toContain(1);
  });

  it('survives an instance matcher called with no argument at all', async () => {
    expect(await reportedLines('edge-shapes.test.ts')).not.toContain(2);
  });

  it('leaves a comparison that is not an identity test alone', async () => {
    expect(await reportedLines('edge-shapes.test.ts')).not.toContain(3);
  });

  it('reports a typeof comparison written with its operands reversed', async () => {
    expect(await reportedLines('edge-shapes.test.ts')).toContain(4);
  });

  it('leaves a private method call alone', async () => {
    expect(await reportedLines('edge-shapes.test.ts')).not.toContain(9);
  });

  it('survives a truth matcher called with no argument over a typeof comparison', async () => {
    expect(await reportedLines('edge-shapes.test.ts')).not.toContain(13);
  });
});

describe('the message stands alone', () => {
  it('names expectExposes and the shape-contract use it serves', async () => {
    const [message] = await lint('banned.test.ts');

    expect(message?.message).toMatch(
      /expectExposes\(subject, \.\.\.names\)[\s\S]*exposes a named API/
    );
  });

  it('names expectCompileTimeProof and the compile-time-proof use it serves', async () => {
    const [message] = await lint('banned.test.ts');

    expect(message?.message).toMatch(/expectCompileTimeProof\(thunk\)[\s\S]*@ts-expect-error/);
  });

  it('names the subpath the helpers ship at', async () => {
    const [message] = await lint('banned.test.ts');

    expect(message?.message).toContain('@hushbox/shared/test-assertions');
  });

  it('says what to do at a site neither helper fits', async () => {
    const [message] = await lint('banned.test.ts');

    expect(message?.message).toContain('rename the test');
  });
});

describe('the ban ships with no exemption mechanism', () => {
  it('accepts no options at all', () => {
    expect(noRawFunctionTypeAssertion.meta?.schema).toEqual([]);
  });
});

describe('the shipped topic config', () => {
  it('scopes the rule to test files through the shared glob', () => {
    expect(topicConfig.map((entry) => entry.files)).toEqual([[TEST_FILE_GLOB]]);
  });

  it('turns the rule on with no options, so there is nothing to exempt', () => {
    expect(topicConfig.map((entry) => entry.rules?.[RULE_KEY])).toEqual(['error']);
  });

  it('registers this rule module under the key it turns on', () => {
    expect(topicConfig[0]?.plugins?.['vacuity']?.rules?.['no-raw-function-type-assertion']).toBe(
      noRawFunctionTypeAssertion
    );
  });

  it('is discovered by the extension loader, so no registration step exists', async () => {
    const loaded = await loadEslintExtensions(new URL('../', import.meta.url));

    expect(loaded.filter((entry) => entry.rules?.[RULE_KEY] !== undefined)).toHaveLength(1);
  });
});
