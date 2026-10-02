// @ts-check
// Programmatic ESLint tests for the vendored require-reason rule.
//
// Two proofs, deliberately obtained by different routes. WHERE the rule runs is
// resolved from the real exported config, so a registration that stops covering
// a language or stops excluding the generated route tree fails here rather than
// shipping; a copy of the `files` globs asserted against itself would prove
// nothing. WHAT it reports is obtained by linting fixture FILES through the
// extension config itself, because a directive's effect depends on the comment's
// position in a real file — which `lintText` over a string fragment does not
// model faithfully for the suppression case below.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { createBaseConfig } from '../../eslint.config.js';
import extensionConfig from '../disable-directives.config.mjs';

const RULE_ID = 'disable-directives/require-reason';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const repoRoot = path.resolve(packageRoot, '..', '..');
const fixturesDir = path.join(here, '__test-fixtures-require-disable-reason__');

const realConfig = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  overrideConfig: createBaseConfig(repoRoot),
});

/**
 * The value the real exported config computes for this rule at one path.
 * @param {string} relativePath - Path relative to the repository root.
 */
async function ruleValueAt(relativePath) {
  const config = await realConfig.calculateConfigForFile(
    path.join(repoRoot, ...relativePath.split('/'))
  );
  return config.rules?.[RULE_ID];
}

const fixtureLinter = new ESLint({
  cwd: fixturesDir,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.{ts,tsx,mjs}'],
      // The fixtures suppress a rule that never fires, so every directive in
      // them is an unused one; reporting those would bury what is under test.
      linterOptions: { reportUnusedDisableDirectives: 'off' },
    },
    { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } },
    ...extensionConfig,
  ],
});

/** @param {string} fixtureFile */
async function lintFixture(fixtureFile) {
  const [result] = await fixtureLinter.lintFiles([path.join(fixturesDir, fixtureFile)]);
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return {
    reported: result.messages.filter((message) => message.ruleId === RULE_ID),
    suppressed: result.suppressedMessages.filter((message) => message.ruleId === RULE_ID),
  };
}

/** @param {string} fixtureFile */
async function reportedIn(fixtureFile) {
  const { reported } = await lintFixture(fixtureFile);
  return reported;
}

describe('where the suppression-reason rule runs', () => {
  it('is an error for a TypeScript module', async () => {
    expect(await ruleValueAt('packages/config/src/thing.ts')).toEqual([2]);
  });

  it('is an error for a TSX module', async () => {
    expect(await ruleValueAt('packages/config/src/thing.tsx')).toEqual([2]);
  });

  it('is an error for a native ES module', async () => {
    expect(await ruleValueAt('packages/config/src/thing.mjs')).toEqual([2]);
  });

  it('does not reach the generated route tree', async () => {
    expect(await ruleValueAt('apps/web/src/routeTree.gen.ts')).toBeUndefined();
  });
});

describe('what the suppression-reason rule reports', () => {
  it('reports a block disable carrying no reason', async () => {
    expect(await reportedIn('bare-block.ts')).toHaveLength(1);
  });

  it('reports a next-line disable carrying no reason', async () => {
    expect(await reportedIn('bare-next-line.ts')).toHaveLength(1);
  });

  it('reports a same-line disable carrying no reason', async () => {
    expect(await reportedIn('bare-line.ts')).toHaveLength(1);
  });

  it('names the directive in the message', async () => {
    const [message] = await reportedIn('bare-next-line.ts');

    expect(message?.messageId).toBe('missingReason');
  });

  it('passes every directive form when each carries a reason', async () => {
    expect(await reportedIn('reasoned.ts')).toEqual([]);
  });

  it('passes a reason written below the separator in a block comment', async () => {
    expect(await reportedIn('reasoned-across-lines.ts')).toEqual([]);
  });

  it('reports a separator with nothing written after it', async () => {
    expect(await reportedIn('empty-reason.ts')).toHaveLength(1);
  });

  it('leaves a re-enabling directive alone, which restores rather than suppresses', async () => {
    expect(await reportedIn('enabled.ts')).toEqual([]);
  });

  it('leaves prose that merely opens with the word alone', async () => {
    expect(await reportedIn('unrelated-comment.ts')).toEqual([]);
  });

  it('reports a bare directive in a TSX module', async () => {
    expect(await reportedIn('bare-next-line.tsx')).toHaveLength(1);
  });

  it('reports a bare directive in a native ES module', async () => {
    expect(await reportedIn('bare-next-line.mjs')).toHaveLength(1);
  });

  // A directive naming no rule disables every rule from its own position
  // onward, and ESLint compares a problem's position against the directive's
  // own, so the report this rule makes about that comment sits inside what the
  // comment disables. The report is made and then suppressed — visible only in
  // ESLint's suppressed-message channel, never in the lint verdict.
  it('reports a blanket disable into the suppressed channel, which no verdict reads', async () => {
    const { reported, suppressed } = await lintFixture('bare-blanket.ts');

    expect(reported).toEqual([]);
    expect(suppressed).toHaveLength(1);
  });
});
