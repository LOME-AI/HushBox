import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedInputsFingerprint } from './seed-fingerprint.js';

/**
 * A checkout in miniature, laid out the way pnpm lays out this one: the seed
 * reaches one module through another, a workspace package through the link pnpm
 * puts in the importer's `node_modules`, an installed package, and a module its
 * runtime provides.
 */
const SEED_TREE: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
  [
    'scripts/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        noEmit: true,
      },
    }),
  ],
  [
    'scripts/seed.ts',
    [
      "import path from 'node:path';",
      "import { first } from './lib/first.js';",
      "import { shared } from '@hushbox/fixture';",
      "import type { Installed } from 'installed';",
      'export const seeded: Installed = { value: path.sep + first + shared };',
      '',
    ].join('\n'),
  ],
  ['scripts/lib/first.ts', "export { second as first } from './second.js';\n"],
  ['scripts/lib/second.ts', "export const second = 'two imports deep';\n"],
  ['scripts/unreached.ts', "export const unreached = 'no import names this';\n"],
  [
    'packages/fixture/package.json',
    JSON.stringify({
      name: '@hushbox/fixture',
      type: 'module',
      exports: { '.': './src/index.ts' },
    }),
  ],
  ['packages/fixture/src/index.ts', "export const shared = 'workspace source';\n"],
  [
    'scripts/node_modules/installed/package.json',
    JSON.stringify({ name: 'installed', types: './index.d.ts' }),
  ],
  ['scripts/node_modules/installed/index.d.ts', 'export interface Installed { value: string }\n'],
];

/** The link pnpm makes from the importer to the workspace package's directory. */
const WORKSPACE_LINK = ['scripts/node_modules/@hushbox/fixture', 'packages/fixture'] as const;

function write(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function writeTree(root: string, entries: readonly (readonly [string, string])[]): void {
  for (const [relativePath, contents] of entries) write(root, relativePath, contents);
  const [link, target] = WORKSPACE_LINK;
  const linkPath = path.join(root, ...link.split('/'));
  mkdirSync(path.dirname(linkPath), { recursive: true });
  // A junction, so the link needs no privilege on Windows; elsewhere the type is ignored.
  symlinkSync(path.join(root, ...target.split('/')), linkPath, 'junction');
}

describe('seedInputsFingerprint', () => {
  let roots: string[] = [];

  function freshRoot(): string {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'seed-fingerprint-')));
    roots.push(root);
    return root;
  }

  function seededRoot(): string {
    const root = freshRoot();
    writeTree(root, SEED_TREE);
    return root;
  }

  beforeEach(() => {
    roots = [];
  });

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('changes when a module the seed reaches two imports deep changes', () => {
    const root = seededRoot();
    const before = seedInputsFingerprint(root);

    write(root, 'scripts/lib/second.ts', "export const second = 'edited';\n");

    expect(seedInputsFingerprint(root)).not.toBe(before);
  });

  it('changes when a workspace package source the seed imports changes', () => {
    const root = seededRoot();
    const before = seedInputsFingerprint(root);

    write(root, 'packages/fixture/src/index.ts', "export const shared = 'edited';\n");

    expect(seedInputsFingerprint(root)).not.toBe(before);
  });

  it('is unchanged when a file the seed does not reach changes', () => {
    const root = seededRoot();
    const before = seedInputsFingerprint(root);

    write(root, 'scripts/unreached.ts', "export const unreached = 'edited';\n");

    expect(seedInputsFingerprint(root)).toBe(before);
  });

  it('changes when the lockfile changes', () => {
    const root = seededRoot();
    const before = seedInputsFingerprint(root);

    write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n# edited\n");

    expect(seedInputsFingerprint(root)).not.toBe(before);
  });

  it('leaves an installed package to the lockfile rather than reading its files', () => {
    const root = seededRoot();
    const before = seedInputsFingerprint(root);

    write(root, 'scripts/node_modules/installed/index.d.ts', 'export interface Installed {}\n');

    expect(seedInputsFingerprint(root)).toBe(before);
  });

  it('gives one digest for one tree whatever its location and the order it was written in', () => {
    const first = freshRoot();
    const second = freshRoot();
    writeTree(first, SEED_TREE);
    writeTree(second, SEED_TREE.toReversed());

    expect(seedInputsFingerprint(second)).toBe(seedInputsFingerprint(first));
  });

  it('walks an import cycle once', () => {
    const root = seededRoot();
    write(
      root,
      'scripts/lib/second.ts',
      "import { first } from './first.js';\nexport const second = 'cycle';\nexport const back = first;\n"
    );

    expect(seedInputsFingerprint(root)).toMatch(/^[\da-f]{64}$/);
  });

  it('refuses an import it cannot resolve, naming the specifier', () => {
    const root = seededRoot();
    write(root, 'scripts/lib/second.ts', "export { gone as second } from './gone.js';\n");

    expect(() => seedInputsFingerprint(root)).toThrow(/'\.\/gone\.js'/);
  });

  it('passes over a module its runtime provides', () => {
    const root = seededRoot();
    write(
      root,
      'packages/fixture/src/index.ts',
      "import { DurableObject } from 'cloudflare:workers';\nexport const shared = DurableObject.name;\n"
    );

    expect(seedInputsFingerprint(root)).toMatch(/^[\da-f]{64}$/);
  });

  it('refuses a checkout whose seed has no tsconfig to resolve under', () => {
    const root = freshRoot();
    writeTree(
      root,
      SEED_TREE.filter(([relativePath]) => relativePath !== 'scripts/tsconfig.json')
    );

    expect(() => seedInputsFingerprint(root)).toThrow(/tsconfig\.json/);
  });

  describe('on a platform whose path separator is a backslash', () => {
    afterEach(() => {
      vi.doUnmock('node:path');
      vi.resetModules();
    });

    /**
     * The module reloaded with `node:path` answering `\\` as its separator, as it
     * does on Windows. The compiler is an external dependency this mock never
     * reaches, so it still answers resolved files with `/` separators, as it does
     * on Windows too.
     */
    async function underBackslashSeparator(): Promise<typeof seedInputsFingerprint> {
      vi.resetModules();
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        const windowsSeparated = { ...actual, sep: '\\' };
        return { ...windowsSeparated, default: windowsSeparated };
      });
      const reloaded = await import('./seed-fingerprint.js');
      return reloaded.seedInputsFingerprint;
    }

    it('still leaves an installed package to the lockfile rather than reading its files', async () => {
      const fingerprint = await underBackslashSeparator();
      const root = seededRoot();
      const before = fingerprint(root);

      write(root, 'scripts/node_modules/installed/index.d.ts', 'export interface Installed {}\n');

      expect(fingerprint(root)).toBe(before);
    });
  });
});
