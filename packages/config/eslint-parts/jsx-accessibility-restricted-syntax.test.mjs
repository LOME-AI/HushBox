// @ts-check
// The frontend `no-restricted-syntax` blocks, exercised against the real
// exported config rather than against a copy of their selectors. Two blocks set
// that key for frontend files — one matching every JSX file, one scoped to a
// source tree — and flat config replaces rather than merges a rule key, so each
// must carry the whole set it means to enforce. A selector dropped from either
// fails here instead of shipping as a ban that silently stops firing.
//
// Resolution and application are two steps on purpose. Resolving reads the rule
// value the real config computes for a path, which is what proves the scoping;
// applying it in an isolated linter keeps the fixtures out of any tsconfig
// project, which the base config's type-aware parsing would otherwise demand.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { createBaseConfig, reactConfig, testConfig } from '../eslint.config.js';
import { doubleCastRestrictedSyntax } from './escape-hatches.mjs';
import { jsxAccessibilityRestrictedSyntax } from './jsx-accessibility-restricted-syntax.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** @param {import('eslint').Linter.Config[]} config */
const composedLinter = (config) =>
  new ESLint({ cwd: packageRoot, overrideConfigFile: true, overrideConfig: config });

// The glob covers `.tsx` as well as `.ts`: a fixture whose path the glob misses
// is linted by nothing and reports nothing, which is the shape in which an
// assertion about a `.tsx` path passes while proving nothing about it.
/** @type {import('eslint').Linter.Config} */
const TYPESCRIPT_FIXTURE = {
  files: ['**/*.{ts,tsx}'],
  languageOptions: { parser: tseslint.parser },
  plugins: { '@typescript-eslint': tseslint.plugin },
};

// What a React package composes: the base, then the frontend blocks, then the
// test-file relaxations.
const reactPackage = composedLinter([
  ...createBaseConfig(packageRoot),
  ...reactConfig,
  ...testConfig,
]);

// A `.tsx` file outside any source tree, where the block matching every JSX file
// is the last word on the rule key, and one inside `src`, where the
// source-scoped block is.
const EVERY_JSX_FILE = 'thing.tsx';
const SOURCE_TREE_FILE = 'src/thing.tsx';

const RAW_IMG = 'export const a = <img src={s} />;\n';
const LAUNDERED = 'export const a = value as unknown as Target;\n';

/**
 * The value the real config computes for `no-restricted-syntax` at one path.
 * @param {string} relativePath
 */
async function restrictedSyntaxAt(relativePath) {
  const config = await reactPackage.calculateConfigForFile(
    path.join(packageRoot, ...relativePath.split('/'))
  );
  return config.rules['no-restricted-syntax'];
}

/**
 * Counts what `no-restricted-syntax` reports over fixture text, applying the
 * value the real config gives that path.
 * @param {string} code
 * @param {string} relativePath
 */
async function reportCountAt(code, relativePath) {
  const isolated = composedLinter([
    {
      ...TYPESCRIPT_FIXTURE,
      rules: { 'no-restricted-syntax': await restrictedSyntaxAt(relativePath) },
    },
  ]);
  const [result] = await isolated.lintText(code, {
    filePath: path.join(packageRoot, ...relativePath.split('/')),
  });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  // A parse failure carries no rule id, so it would otherwise be filtered out
  // below and read as a clean fixture — the shape in which a fixture parsed by
  // the wrong parser passes an assertion that nothing fired.
  const fatal = result.messages.find((message) => message.fatal);
  if (fatal) throw new Error(`the fixture did not parse: ${fatal.message}`);
  return result.messages.filter((message) => message.ruleId === 'no-restricted-syntax').length;
}

describe('the JSX accessibility selectors', () => {
  it('are all carried by the block matching every JSX file', async () => {
    expect(await restrictedSyntaxAt(EVERY_JSX_FILE)).toEqual(
      expect.arrayContaining(jsxAccessibilityRestrictedSyntax)
    );
  });

  it('are all carried by the source-scoped block', async () => {
    expect(await restrictedSyntaxAt(SOURCE_TREE_FILE)).toEqual(
      expect.arrayContaining(jsxAccessibilityRestrictedSyntax)
    );
  });

  it('report a raw img element outside a source tree', async () => {
    expect(await reportCountAt(RAW_IMG, EVERY_JSX_FILE)).toBe(1);
  });

  it('report a raw img element inside a source tree', async () => {
    expect(await reportCountAt(RAW_IMG, SOURCE_TREE_FILE)).toBe(1);
  });
});

describe('the double-cast ban under the frontend blocks', () => {
  it('is carried in full by the source-scoped block', async () => {
    expect(await restrictedSyntaxAt(SOURCE_TREE_FILE)).toEqual(
      expect.arrayContaining(doubleCastRestrictedSyntax)
    );
  });

  it('reports a laundered cast in a source-tree tsx module', async () => {
    expect(await reportCountAt(LAUNDERED, SOURCE_TREE_FILE)).toBe(1);
  });
});
