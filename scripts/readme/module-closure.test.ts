import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectModuleClosure } from './module-closure.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

describe('collectModuleClosure', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'module-closure-')));
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  function write(relativePath: string, source: string): string {
    const filePath = path.join(fixtureDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
    return filePath;
  }

  it('reaches the module that declares a named binding through a re-export barrel', () => {
    const implementation = write('impl.ts', 'export const value = 1;\n');
    write('barrel.ts', "export * from './impl.js';\n");
    const entry = write(
      'entry.ts',
      "import { value } from './barrel.js';\nexport const used = value;\n"
    );

    expect(collectModuleClosure([entry])).toContain(implementation);
  });

  // The narrowing's one deliberate hole: a star barrel declares nothing of its
  // own, so a top-level side effect added to it invalidates no cache. Pinned
  // here because the rest of the design is argued from it.
  it('leaves a star-forwarding barrel itself out of the closure', () => {
    write('impl.ts', 'export const value = 1;\n');
    const barrel = write('barrel.ts', "export * from './impl.js';\n");
    const entry = write(
      'entry.ts',
      "import { value } from './barrel.js';\nexport const used = value;\n"
    );

    expect(collectModuleClosure([entry])).not.toContain(barrel);
  });

  it('reaches a module imported for its side effects alone', () => {
    const effects = write('effects.ts', 'globalThis.structuredClone(1);\n');
    const entry = write('entry.ts', "import './effects.js';\nexport const used = 1;\n");

    expect(collectModuleClosure([entry])).toContain(effects);
  });

  it('reaches a module bound as a default export', () => {
    const target = write('default.ts', 'export default 1;\n');
    const entry = write(
      'entry.ts',
      "import value from './default.js';\nexport const used = value;\n"
    );

    expect(collectModuleClosure([entry])).toContain(target);
  });

  it('reaches what a module in the closure forwards with a star re-export', () => {
    const implementation = write('impl.ts', 'export const value = 1;\n');
    write('barrel.ts', "export * from './impl.js';\n");
    const entry = write(
      'entry.ts',
      "import * as barrel from './barrel.js';\nexport const used = barrel.value;\n"
    );

    expect(collectModuleClosure([entry])).toContain(implementation);
  });

  it('reaches what a module in the closure forwards by name', () => {
    const implementation = write('impl.ts', 'export const value = 1;\n');
    write('barrel.ts', "export { value } from './impl.js';\n");
    const entry = write(
      'entry.ts',
      "import * as barrel from './barrel.js';\nexport const used = barrel.value;\n"
    );

    expect(collectModuleClosure([entry])).toContain(implementation);
  });

  it('leaves out a dynamic import whose target is only named at run time', () => {
    write('lazy.ts', 'export const value = 1;\n');
    const entry = write(
      'entry.ts',
      "const which = './lazy.js';\nexport const load = async (): Promise<unknown> => import(which);\n"
    );

    expect(collectModuleClosure([entry])).toEqual([entry]);
  });

  it('leaves out a specifier that resolves to nothing', () => {
    const entry = write(
      'entry.ts',
      "import { value } from './absent.js';\nexport const used = value;\n"
    );

    expect(collectModuleClosure([entry])).toEqual([entry]);
  });

  it('reaches a module bound as a namespace', () => {
    const namespaceModule = write('ns.ts', 'export const value = 1;\n');
    const entry = write(
      'entry.ts',
      "import * as ns from './ns.js';\nexport const used = ns.value;\n"
    );

    expect(collectModuleClosure([entry])).toContain(namespaceModule);
  });

  it('reaches a module behind a dynamic import', () => {
    const lazy = write('lazy.ts', 'export const value = 1;\n');
    const entry = write(
      'entry.ts',
      "export const load = async (): Promise<unknown> => import('./lazy.js');\n"
    );

    expect(collectModuleClosure([entry])).toContain(lazy);
  });

  it('includes the entry itself', () => {
    const entry = write('entry.ts', 'export const value = 1;\n');

    expect(collectModuleClosure([entry])).toEqual([entry]);
  });

  it('returns the entry alone when it does not exist on disk', () => {
    const missing = path.join(fixtureDir, 'absent.ts');

    expect(collectModuleClosure([missing])).toEqual([missing]);
  });

  it('leaves third-party modules out of the closure', () => {
    const closure = collectModuleClosure([
      path.join(REPO_ROOT, 'scripts/readme/generate-icons.ts'),
    ]);

    expect(closure.filter((file) => file.includes('node_modules'))).toEqual([]);
  });

  // The digest hashes this list in order, so discovery order — which depends on
  // which specifier the walk happens to meet first — must not reach it.
  it('orders the closure by path rather than by discovery', () => {
    const implementation = write('a-impl.ts', 'export const value = 1;\n');
    write('b-barrel.ts', "export * from './a-impl.js';\n");
    const entry = write(
      'c-entry.ts',
      "import { value } from './b-barrel.js';\nexport const used = value;\n"
    );

    expect(collectModuleClosure([entry])).toEqual([implementation, entry]);
  });
});
