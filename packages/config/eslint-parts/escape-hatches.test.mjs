// @ts-check
// The double-cast ban, exercised against the real exported config rather than
// against a copy of its selectors: the rule value is resolved per file path, so
// a selector that stops firing — or starts firing on test code, which stands in
// for types it cannot construct — fails here instead of shipping.
//
// Resolution and application are two steps on purpose. Resolving reads the rule
// value the real config computes for a path, which is what proves the scoping;
// applying it in an isolated linter keeps the fixtures out of any tsconfig
// project, which the base config's type-aware parsing would otherwise demand.
//
// One composition per block that carries the ban. Flat config replaces a rule
// key rather than merging it, so only the last block matching a path reaches
// it, and a composition that stops short of a block proves nothing about it:
// the base alone never reaches the frontend or astro blocks, whatever path it
// is asked about.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { astroConfig, createBaseConfig, reactConfig, testConfig } from '../eslint.config.js';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** @param {import('eslint').Linter.Config[]} config */
const composedLinter = (config) =>
  new ESLint({ cwd: packageRoot, overrideConfigFile: true, overrideConfig: config });

/** @type {import('eslint').Linter.Config} */
const TYPESCRIPT_FIXTURE = {
  files: ['**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  plugins: { '@typescript-eslint': tseslint.plugin },
};

const astroParser = astroConfig.find((entry) => entry.languageOptions?.['parser'])
  ?.languageOptions?.['parser'];
if (astroParser === undefined) throw new Error('the astro config registers no parser');

/**
 * An `.astro` file's frontmatter is TypeScript, which astro-eslint-parser reads
 * as such only when handed a TypeScript parser of its own; without one the
 * fixture dies on the first `as`.
 * @type {import('eslint').Linter.Config}
 */
const ASTRO_FIXTURE = {
  files: ['**/*.astro'],
  languageOptions: {
    parser: astroParser,
    sourceType: 'module',
    parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.astro'] },
  },
};

// A composition of the exported config, paired with the parser the files it
// governs are written in. Each mirrors what a package of that kind composes:
// a Node or Worker package takes the base, a React package adds reactConfig
// after it, and the marketing site adds astroConfig after that.
const NODE_PACKAGE = {
  linter: composedLinter([...createBaseConfig(packageRoot), ...testConfig]),
  fixture: TYPESCRIPT_FIXTURE,
};
const REACT_PACKAGE = {
  linter: composedLinter([...createBaseConfig(packageRoot), ...reactConfig, ...testConfig]),
  fixture: TYPESCRIPT_FIXTURE,
};
const ASTRO_PAGE = {
  linter: composedLinter([
    ...createBaseConfig(packageRoot),
    ...reactConfig,
    ...astroConfig,
    ...testConfig,
  ]),
  fixture: ASTRO_FIXTURE,
};

const SOURCE = 'src/thing.ts';
const LAUNDERED = 'export const a = value as unknown as Target;\n';
const HONEST = 'export const a = value as Target;\n';
const ASTRO_SOURCE = 'src/pages/thing.astro';
/** @param {string} frontmatter */
const astroPage = (frontmatter) => `---\n${frontmatter}\n---\n<p>a</p>\n`;

/**
 * The value the real config computes for one rule at one path.
 * @param {{linter: ESLint}} composition
 * @param {string} ruleId
 * @param {string} relativePath
 */
async function ruleValueAt(composition, ruleId, relativePath) {
  const config = await composition.linter.calculateConfigForFile(
    path.join(packageRoot, ...relativePath.split('/'))
  );
  return config.rules[ruleId];
}

/**
 * Counts what one rule reports over fixture text, applying the value the real
 * config gives that path.
 * @param {{linter: ESLint, fixture: import('eslint').Linter.Config}} composition
 * @param {string} ruleId
 * @param {string} code
 * @param {string} relativePath
 */
async function reportCountAt(composition, ruleId, code, relativePath) {
  const value = await ruleValueAt(composition, ruleId, relativePath);
  const isolated = composedLinter([{ ...composition.fixture, rules: { [ruleId]: value } }]);
  const [result] = await isolated.lintText(code, {
    filePath: path.join(packageRoot, ...relativePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  // A parse failure carries no rule id, so it would otherwise be filtered out
  // below and read as a clean fixture — the shape in which a language parsed by
  // the wrong parser passes an assertion that nothing fired.
  const fatal = result.messages.find((message) => message.fatal);
  if (fatal) throw new Error(`the fixture did not parse: ${fatal.message}`);
  return result.messages.filter((message) => message.ruleId === ruleId).length;
}

/** @param {string} code */
const inProductionSource = (code) =>
  reportCountAt(NODE_PACKAGE, 'no-restricted-syntax', code, SOURCE);

describe('the double-cast ban', () => {
  it('reports a cast laundered through unknown', async () => {
    expect(await inProductionSource(LAUNDERED)).toBe(1);
  });

  it('reports a cast laundered through never', async () => {
    expect(await inProductionSource('export const a = value as never as Target;\n')).toBe(1);
  });

  it('reports a laundered cast whose inner half is parenthesised', async () => {
    expect(await inProductionSource('export const a = (value as unknown) as Target;\n')).toBe(1);
  });

  it('reports a laundered cast whose inner half is written angle-bracket style', async () => {
    expect(await inProductionSource('export const a = (<unknown>value) as Target;\n')).toBe(1);
  });

  it('passes an honest single cast', async () => {
    expect(await inProductionSource(HONEST)).toBe(0);
  });

  it('passes a laundered cast in a test module, which stands in for types it cannot build', async () => {
    expect(
      await reportCountAt(NODE_PACKAGE, 'no-restricted-syntax', LAUNDERED, 'src/thing.test.ts')
    ).toBe(0);
  });

  it('passes a laundered cast in a test-support module', async () => {
    expect(
      await reportCountAt(
        NODE_PACKAGE,
        'no-restricted-syntax',
        LAUNDERED,
        'src/test-support/double.ts'
      )
    ).toBe(0);
  });

  it('keeps the cross-platform shell-out bans for a test module', async () => {
    expect(
      await reportCountAt(
        NODE_PACKAGE,
        'no-restricted-syntax',
        "execa('rm', ['-rf', target]);\n",
        'src/thing.test.ts'
      )
    ).toBe(1);
  });
});

describe('the double-cast ban where a frontend block is the last word', () => {
  it("reports a laundered cast in a React package's source", async () => {
    expect(await reportCountAt(REACT_PACKAGE, 'no-restricted-syntax', LAUNDERED, SOURCE)).toBe(1);
  });

  it("passes an honest single cast in a React package's source", async () => {
    expect(await reportCountAt(REACT_PACKAGE, 'no-restricted-syntax', HONEST, SOURCE)).toBe(0);
  });

  it("passes a laundered cast in a React package's test-support module", async () => {
    expect(
      await reportCountAt(
        REACT_PACKAGE,
        'no-restricted-syntax',
        LAUNDERED,
        'src/test-utils/double.ts'
      )
    ).toBe(0);
  });

  it('reports a laundered cast in astro frontmatter', async () => {
    expect(
      await reportCountAt(
        ASTRO_PAGE,
        'no-restricted-syntax',
        astroPage('const a = value as unknown as Target;'),
        ASTRO_SOURCE
      )
    ).toBe(1);
  });

  it('passes an honest single cast in astro frontmatter', async () => {
    expect(
      await reportCountAt(
        ASTRO_PAGE,
        'no-restricted-syntax',
        astroPage('const a = value as Target;'),
        ASTRO_SOURCE
      )
    ).toBe(0);
  });
});

describe('the angle-bracket assertion style', () => {
  it('reports a cast laundered through an angle-bracket unknown', async () => {
    expect(
      await reportCountAt(
        NODE_PACKAGE,
        '@typescript-eslint/consistent-type-assertions',
        'export const a = <Target>(<unknown>value);\n',
        SOURCE
      )
    ).toBeGreaterThan(0);
  });

  // The severity comes back as ESLint's normalised number rather than the word
  // the config spells it with; the options are what say the style is declared.
  it('is declared rather than inherited, so a preset default cannot move it', async () => {
    expect(
      await ruleValueAt(NODE_PACKAGE, '@typescript-eslint/consistent-type-assertions', SOURCE)
    ).toEqual([2, { assertionStyle: 'as' }]);
  });
});
