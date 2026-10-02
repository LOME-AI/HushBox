// The gate over every repository path a lint or architecture rule hard-codes.
// The behaviour under test is the failure direction: a rule whose scope points
// at a tree that is not there must be reported, because nothing else reports it
// — the rule goes on running over nothing and its colocated test goes on
// passing, having been handed fixture filenames built from the same string.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_ROOT,
  disarmedPathsIn,
  isGovernedModule,
  governedModuleNamedPaths,
  GOVERNED_TREES,
  NON_WORKSPACE_ROOTS,
  repoPathsIn,
  resolvesInRepo,
  splicedPathsIn,
  SYNTHETIC_RULE_PATHS,
  unresolvedNamedPaths,
} from './rule-named-paths.mjs';

describe('the paths a rule names', () => {
  it('reports a scope regex pointing at a directory that is not on disk', () => {
    const rule = String.raw`const SCOPE = /\/apps\/api\/src\/slices\/PHANTOM\/domain\/(engine|nodes)\//;`;

    const named = repoPathsIn(rule, 'scope.mjs');

    expect(named).toEqual(['apps/api/src/slices/PHANTOM/domain']);
    expect(resolvesInRepo(named[0])).toBe(false);
  });

  it('accepts a scope regex pointing at a directory that is on disk', () => {
    const rule = String.raw`const SCOPE = /\/apps\/api\/src\/slices\/workflows\/domain\/(engine|nodes)\//;`;

    expect(resolvesInRepo(repoPathsIn(rule, 'scope.mjs')[0])).toBe(true);
  });

  it('accepts a module scope written without its extension', () => {
    const rule = String.raw`const R = /\/apps\/api\/src\/slices\/workflows\/domain\/engine\/live-execution-registry(?:\.[cm]?[jt]s)?$/;`;

    const named = repoPathsIn(rule, 'scope.mjs');

    expect(named).toEqual(['apps/api/src/slices/workflows/domain/engine/live-execution-registry']);
    expect(resolvesInRepo(named[0])).toBe(true);
  });

  it('ends a path at an unbracketed character class, which names no directory', () => {
    const rule = String.raw`const SCOPE = /\/apps\/web\/src\/\w+\/index\.ts$/;`;

    expect(repoPathsIn(rule, 'scope.mjs')).toEqual(['apps/web/src']);
  });

  it('ends a path at a character class that a partial segment leads into', () => {
    const rule = String.raw`const SCOPE = /\/apps\/api\/src\/v\d\/routes\.ts$/;`;

    expect(repoPathsIn(rule, 'scope.mjs')).toEqual(['apps/api/src']);
  });

  it('ends a path at a bracketed character class', () => {
    const rule = String.raw`const SCOPE = /\/apps\/api\/src\/slices\/[\w-]+\/domain\//;`;

    expect(repoPathsIn(rule, 'scope.mjs')).toEqual(['apps/api/src/slices']);
  });

  it('ends a path at an alternation over the segments a scope admits', () => {
    const rule = String.raw`const SCOPE = /\/apps\/api\/src\/slices\/(chat|billing)\/routes\.ts$/;`;

    expect(repoPathsIn(rule, 'scope.mjs')).toEqual(['apps/api/src/slices']);
  });

  it('reads a documentation path a rule cites in the message it refuses code with', () => {
    const rule = `export const MESSAGE = 'Money internals are owners-only — see docs/BILLING.md';`;

    expect(repoPathsIn(rule, 'rule.ts')).toEqual(['docs/BILLING.md']);
  });

  it('ends a path before the full stop of the sentence citing it', () => {
    const rule = `export const MESSAGE = 'Money internals are owners-only — see docs/BILLING.md.';`;

    expect(repoPathsIn(rule, 'rule.ts')).toEqual(['docs/BILLING.md']);
  });

  it('reads a path out of a plain string scope', () => {
    expect(repoPathsIn(`export const files = ['apps/api/src/**/*.ts'];`, 'c.mjs')).toEqual([
      'apps/api/src',
    ]);
  });

  it('ends a path at a wildcard, not at the separator in front of it', () => {
    const rule = String.raw`const FILES = '/apps/api/src/.*\.tsx?$';`;

    expect(repoPathsIn(rule, 'c.mjs')).toEqual(['apps/api/src']);
  });

  it('reads a path out of a template literal that interpolates nothing', () => {
    expect(repoPathsIn('const g = `packages/shared/src/money.ts`;', 'c.mjs')).toEqual([
      'packages/shared/src/money.ts',
    ]);
  });

  it('reads no scope out of a path a concatenation splices', () => {
    const rule = `export const M = 'packages/config/arch/lib/' + 'module-references.ts';`;

    expect(repoPathsIn(rule, 'rule.ts')).toEqual([]);
  });

  it('refuses the prefix a concatenation splices a path onto', () => {
    const rule = `export const M = 'packages/config/arch/lib/' + 'module-references.ts';`;

    expect(splicedPathsIn(rule, 'rule.ts')).toEqual(['packages/config/arch/lib']);
  });

  it('reads no scope out of a path an interpolation splices', () => {
    const rule = 'export const M = `packages/config/arch/lib/${leaf}`;';

    expect(repoPathsIn(rule, 'rule.ts')).toEqual([]);
  });

  it('refuses the prefix an interpolation splices a path onto', () => {
    const rule = 'export const M = `packages/config/arch/lib/${leaf}`;';

    expect(splicedPathsIn(rule, 'rule.ts')).toEqual(['packages/config/arch/lib']);
  });

  it('reads a whole path a concatenated sentence carries on past', () => {
    const rule = `export const M = 'Money internals are owners-only — see docs/BILLING.md for ' + why;`;

    expect(repoPathsIn(rule, 'rule.ts')).toEqual(['docs/BILLING.md']);
  });

  it('refuses nothing in a concatenated sentence whose path is whole', () => {
    const rule = `export const M = 'Money internals are owners-only — see docs/BILLING.md for ' + why;`;

    expect(splicedPathsIn(rule, 'rule.ts')).toEqual([]);
  });

  it('refuses a path a template ends on when a concatenation continues past it', () => {
    const rule = 'export const M = `packages/config/arch/lib` + leaf;';

    expect(splicedPathsIn(rule, 'rule.ts')).toEqual(['packages/config/arch/lib']);
  });

  it('reads a path in the tail of a concatenation, which nothing follows', () => {
    const rule = `export const M = why + ' — see docs/BILLING.md';`;

    expect(splicedPathsIn(rule, 'rule.ts')).toEqual([]);
  });

  it('ignores a path that appears only in prose, which is not a scope', () => {
    const rule = [
      '/** Once watched apps/api/src/platform/roadmap/routes.ts. */',
      '// see apps/api/src/nowhere/at-all.ts',
      'export default {};',
    ].join('\n');

    expect(repoPathsIn(rule, 'rule.mjs')).toEqual([]);
  });

  it('reports nothing for a module that names no repository path', () => {
    expect(repoPathsIn(`const banned = ['zod', 'node:fs'];`, 'rule.mjs')).toEqual([]);
  });

  it('reads nothing out of a tagged template whose escape leaves it uncooked', () => {
    const source = 'raw`\\unicode apps/api/src`;';

    expect(repoPathsIn(source, 'rule.mjs')).toEqual([]);
  });
});

describe('which files the gate reads a scope out of', () => {
  it.each([
    'rule.js',
    'rule.jsx',
    'rule.ts',
    'rule.tsx',
    'rule.cjs',
    'rule.mjs',
    'rule.cts',
    'rule.mts',
  ])('reads %s, because a rule can be written in it', (fileName) => {
    expect(isGovernedModule(fileName)).toBe(true);
  });

  it.each(['engine-purity.test.mjs', 'paths.spec.ts', 'harness.setup.mjs'])(
    'leaves %s alone, because it exists only so tests can run',
    (fileName) => {
      expect(isGovernedModule(fileName)).toBe(false);
    }
  );

  it.each(['README.md', 'tsconfig.json', 'LICENSE'])(
    'leaves %s alone, because it is no module',
    (fileName) => {
      expect(isGovernedModule(fileName)).toBe(false);
    }
  );
});

const declaredSyntheticPaths = Object.entries(SYNTHETIC_RULE_PATHS).flatMap(([module, paths]) =>
  Object.entries(paths).map(([named, reason]) => ({ module, named, reason }))
);

describe('a module whose scope has been relocated out from under it', () => {
  const module = 'eslint-extensions/rules/scope.mjs';

  it('is named, with the path it now points nowhere at', () => {
    const found = disarmedPathsIn({
      module,
      named: ['apps/api/src/slices/PHANTOM/domain'],
    });

    expect(found).toEqual([`${module} names 'apps/api/src/slices/PHANTOM/domain'`]);
  });

  it('is named for a path it splices, though the prefix left of the splice resolves', () => {
    const found = disarmedPathsIn({
      module,
      named: [],
      spliced: ['packages/config/arch/lib'],
    });

    expect(found).toEqual([
      `${module} splices a path onto 'packages/config/arch/lib', which nothing can check`,
    ]);
  });

  it('is left alone while its scope still resolves', () => {
    const found = disarmedPathsIn({
      module,
      named: ['apps/api/src/slices/workflows/domain'],
    });

    expect(found).toEqual([]);
  });

  it('is left alone where the path is declared to name absence', () => {
    const [declared] = declaredSyntheticPaths;

    expect(disarmedPathsIn({ module: declared.module, named: [declared.named] })).toEqual([]);
  });
});

describe('the shipped rule layers', () => {
  it('name only paths that resolve, so a relocation cannot disarm a rule in silence', () => {
    expect(
      unresolvedNamedPaths(),
      'A rule scope names a path nothing is at, so the rule now runs over nothing while every test of it still passes. Repoint the scope at where the code went, or — if it is meant to name absence — declare it in SYNTHETIC_RULE_PATHS with the reason.'
    ).toEqual([]);
  });

  it('declare a reason for every path deliberately naming nothing', () => {
    expect(declaredSyntheticPaths.filter(({ reason }) => reason === '')).toEqual([]);
  });

  it('carry no synthetic declaration for a path that resolves after all', () => {
    expect(declaredSyntheticPaths.filter(({ named }) => resolvesInRepo(named))).toEqual([]);
  });
});

// The gate's own scope is a path constant, so it decays exactly the way the
// scopes it reads do — and a tree it could not find would read as a tree with
// nothing wrong in it.
describe('the gate itself', () => {
  it.each(GOVERNED_TREES)('finds the %s tree it is pointed at', (tree) => {
    expect(existsSync(path.join(CONFIG_ROOT, tree))).toBe(true);
  });

  it.each(Object.keys(NON_WORKSPACE_ROOTS))(
    'finds the %s directory it reaches into past the workspace manifest',
    (root) => {
      expect(resolvesInRepo(root)).toBe(true);
    }
  );

  it('declares a reason for every directory it reaches into past the workspace manifest', () => {
    expect(Object.entries(NON_WORKSPACE_ROOTS).filter(([, reason]) => reason === '')).toEqual([]);
  });

  it('reaches both rule layers, the two rules whose scopes proved this defect included', () => {
    const modules = governedModuleNamedPaths().map(({ module }) => module);

    expect(modules).toContain('eslint-extensions/rules/engine-node-purity.mjs');
    expect(modules).toContain('eslint-extensions/rules/capability-registry-only.mjs');
    expect(modules.some((module) => module.startsWith('arch/rules/'))).toBe(true);
  });

  it('reaches the config parts the shared ESLint config is assembled from', () => {
    const modules = governedModuleNamedPaths().map(({ module }) => module);

    expect(modules.some((module) => module.startsWith('eslint-parts/'))).toBe(true);
  });

  it('reaches the shared ESLint config the rule layers compose into', () => {
    const modules = governedModuleNamedPaths().map(({ module }) => module);

    expect(modules).toContain('eslint.config.js');
  });
});
