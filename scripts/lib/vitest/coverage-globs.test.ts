import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadPackageCoverageGlobs, remapGlobs } from './coverage-globs.js';

describe('remapGlobs', () => {
  it('prefixes plain globs with the package directory', () => {
    expect(remapGlobs('apps/api', ['src/**/*.ts'])).toEqual(['apps/api/src/**/*.ts']);
  });

  it('keeps a negation prefix in front of the remapped glob', () => {
    expect(remapGlobs('apps/api', ['!src/generated/**'])).toEqual(['!apps/api/src/generated/**']);
  });

  it('returns nothing for an absent list', () => {
    expect(remapGlobs('apps/api')).toEqual([]);
  });
});

/**
 * A fixture package, never a real one: loading a real config in-process
 * evaluates the shared base-config chain natively (offset 0), while every
 * other suite imports those modules through the runner (wrapper offset) —
 * the exact offset divergence the coverage-offset gate exists to fail on. The
 * scope guard is proven against the real workspace by every package's own test
 * run, which resolves its scope through this loader before vitest starts.
 */
/** Every fixture root this file made, so `afterEach` removes exactly those. */
const fixtureRoots: string[] = [];

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fixturePackage(testOptions: string, sources: readonly string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hb-globs-'));
  fixtureRoots.push(root);
  mkdirSync(path.join(root, 'pkg'), { recursive: true });
  writeFileSync(
    path.join(root, 'pkg', 'vitest.config.ts'),
    `export default { test: { ${testOptions} } };\n`
  );
  for (const source of sources) {
    const file = path.join(root, 'pkg', source);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'export const value = 1;\n');
  }
  return root;
}

describe('loadPackageCoverageGlobs', () => {
  it('reads a package config through the vite loader and remaps its coverage globs', async () => {
    const fixtureRoot = fixturePackage(
      `coverage: { include: ['src/**/*.ts'], exclude: ['src/dist/**'] }`,
      ['src/measured.ts']
    );

    const { include, exclude } = await loadPackageCoverageGlobs(
      fixtureRoot,
      'pkg',
      'vitest.config.ts'
    );

    expect(include).toEqual(['pkg/src/**/*.ts']);
    expect(exclude).toEqual(['pkg/src/dist/**']);
  });

  it('throws on a config file that does not exist', async () => {
    const fixtureRoot = fixturePackage(`coverage: { include: ['src/**/*.ts'] }`, ['src/a.ts']);

    await expect(
      loadPackageCoverageGlobs(fixtureRoot, 'pkg', 'no-such-config.ts')
    ).rejects.toThrow();
  });

  it('throws when the config declares no coverage scope at all', async () => {
    const fixtureRoot = fixturePackage(`name: 'pkg'`, ['src/unmeasured.ts']);

    await expect(loadPackageCoverageGlobs(fixtureRoot, 'pkg', 'vitest.config.ts')).rejects.toThrow(
      /NO COVERAGE SCOPE/
    );
  });

  it('throws when the declared scope reaches no file on disk', async () => {
    const fixtureRoot = fixturePackage(`coverage: { include: ['src/**/*.ts'] }`, []);

    await expect(loadPackageCoverageGlobs(fixtureRoot, 'pkg', 'vitest.config.ts')).rejects.toThrow(
      /COVERAGE SCOPE REACHES NO FILE/
    );
  });

  it('throws when coverage excludes remove every file the scope reaches', async () => {
    const fixtureRoot = fixturePackage(
      `coverage: { include: ['src/**/*.ts'], exclude: ['src/**'] }`,
      ['src/shadowed.ts']
    );

    await expect(loadPackageCoverageGlobs(fixtureRoot, 'pkg', 'vitest.config.ts')).rejects.toThrow(
      /COVERAGE SCOPE MEASURES NO FILE/
    );
  });

  it('subtracts a negated include entry from the files its scope reaches', async () => {
    const fixtureRoot = fixturePackage(`coverage: { include: ['src/**/*.ts', '!src/**'] }`, [
      'src/negated.ts',
    ]);

    await expect(loadPackageCoverageGlobs(fixtureRoot, 'pkg', 'vitest.config.ts')).rejects.toThrow(
      /COVERAGE SCOPE REACHES NO FILE/
    );
  });
});
