// Programmatic ESLint tests for the vendored no-star-exports rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the rule is applied directly to a fixture tree that
// mirrors the repo layout, so the absolute-filename self-scoping is exercised
// exactly as it runs in the real config.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import noStarExports from './no-star-exports.mjs';
import { STAR_EXPORT_EXEMPTIONS } from '../no-star-exports.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__test-fixtures-no-star-exports__');
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const FIXTURE_OPTIONS = {
  scopeDir: 'packages/shared/src/',
  exemptions: [
    { file: 'packages/shared/src/pinned/index.ts' },
    {
      file: 'packages/shared/src/grandfathered.ts',
      exceptTargetsUnder: 'packages/shared/src/money/',
    },
    {
      file: 'packages/shared/src/grandfathered-ts.ts',
      exceptTargetsUnder: 'packages/shared/src/money/',
    },
  ],
};

/** @param {string} file */
async function lint(file) {
  const linter = new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      {
        files: ['**/*.ts'],
        plugins: {
          barrel: { meta: { name: 'barrel' }, rules: { 'no-star-exports': noStarExports } },
        },
        rules: { 'barrel/no-star-exports': ['error', FIXTURE_OPTIONS] },
      },
    ],
  });
  const [result] = await linter.lintFiles([path.join(fixturesDir, ...file.split('/'))]);
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((m) => m.ruleId === 'barrel/no-star-exports');
}

const SHARED = 'packages/shared/src';

describe('no-star-exports', () => {
  it('flags a star into a module that declares its own exports', async () => {
    const [message] = await lint(`${SHARED}/stars-leaf.ts`);

    expect(message?.messageId).toBe('starIntoLeaf');
  });

  it('names the offending specifier in the message', async () => {
    const [message] = await lint(`${SHARED}/stars-leaf.ts`);

    expect(message?.message).toContain('./leaf.js');
  });

  it('flags a star into a leaf written with a `.ts` specifier', async () => {
    const [message] = await lint(`${SHARED}/stars-leaf-ts.ts`);

    expect(message?.messageId).toBe('starIntoLeaf');
  });

  it('allows a star into a pure re-export barrel written with a `.ts` specifier', async () => {
    expect(await lint(`${SHARED}/stars-pure-barrel-ts.ts`)).toEqual([]);
  });

  it('lets an exemption cover a star written with a `.ts` specifier', async () => {
    expect(await lint(`${SHARED}/grandfathered-ts.ts`)).toEqual([]);
  });

  it('flags a star into an index file that declares its own exports', async () => {
    expect(await lint(`${SHARED}/stars-declaring-index.ts`)).toHaveLength(1);
  });

  it('flags a star into a module that exports only local bindings', async () => {
    expect(await lint(`${SHARED}/stars-local-only.ts`)).toHaveLength(1);
  });

  it('flags a star from a package specifier', async () => {
    const [message] = await lint(`${SHARED}/stars-package.ts`);

    expect(message?.messageId).toBe('starIntoUnresolvedModule');
  });

  it('flags a star whose target file does not exist', async () => {
    const [message] = await lint(`${SHARED}/stars-missing.ts`);

    expect(message?.messageId).toBe('starIntoUnresolvedModule');
  });

  it('flags a star into a pure re-export barrel that sits outside the banned scope', async () => {
    const [message] = await lint(`${SHARED}/stars-outside-scope.ts`);

    expect(message?.messageId).toBe('starIntoUngovernedBarrel');
  });

  it('allows a star into a pure re-export barrel inside the banned scope', async () => {
    expect(await lint(`${SHARED}/stars-pure-barrel.ts`)).toEqual([]);
  });

  it('resolves an extensionless specifier to its barrel', async () => {
    expect(await lint(`${SHARED}/stars-extensionless.ts`)).toEqual([]);
  });

  it('allows a star in a file exempted for its inventory pin', async () => {
    expect(await lint(`${SHARED}/pinned/index.ts`)).toEqual([]);
  });

  it('allows a grandfathered file to keep a star outside the protected subtree', async () => {
    const messages = await lint(`${SHARED}/grandfathered.ts`);

    expect(messages.map((m) => m.line)).not.toContain(1);
  });

  it('flags a grandfathered file starring into the protected subtree', async () => {
    const messages = await lint(`${SHARED}/grandfathered.ts`);

    expect(messages.map((m) => m.line)).toEqual([2]);
  });

  it('allows explicit named re-exports', async () => {
    expect(await lint(`${SHARED}/named-only.ts`)).toEqual([]);
  });

  it('allows a namespace star, which binds exactly one reviewer-visible name', async () => {
    expect(await lint(`${SHARED}/stars-namespace.ts`)).toEqual([]);
  });

  it('ignores a star in a file outside the banned scope', async () => {
    expect(await lint('apps/web/src/star.ts')).toEqual([]);
  });
});

describe('the shipped exemption list', () => {
  it('names only files that exist, so an exemption cannot go stale unnoticed', () => {
    const missing = STAR_EXPORT_EXEMPTIONS.filter(
      (entry) => !existsSync(path.join(repoRoot, entry.file))
    );

    expect(missing).toEqual([]);
  });
});
