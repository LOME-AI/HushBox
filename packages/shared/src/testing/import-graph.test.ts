import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testRunnersReachableFrom } from './import-graph.ts';

let root = '';

/** Writes each named source into a fresh directory and returns the entry's path. */
function graph(files: Record<string, string>): string {
  root = mkdtempSync(path.join(tmpdir(), 'import-graph-'));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source, 'utf8');
  }
  return path.join(root, 'entry.ts');
}

afterEach(() => {
  if (root !== '') {
    rmSync(root, { recursive: true, force: true });
    root = '';
  }
});

describe('testRunnersReachableFrom', () => {
  it('reports a runner the entry imports itself', () => {
    const entry = graph({ 'entry.ts': `import { it } from 'vitest';` });

    expect(testRunnersReachableFrom(entry)).toEqual(['vitest']);
  });

  it('reports a runner reached through a relative edge', () => {
    const entry = graph({
      'entry.ts': `export { helper } from './helper.js';`,
      'helper.ts': `import { vi } from 'vitest';\nexport const helper = vi;`,
    });

    expect(testRunnersReachableFrom(entry)).toEqual(['vitest']);
  });

  it('reports nothing when the graph names no runner', () => {
    const entry = graph({
      'entry.ts': `import { z } from 'zod';\nexport { helper } from './nested/helper.js';`,
      'nested/helper.ts': `export const helper = 1;`,
    });

    expect(testRunnersReachableFrom(entry)).toEqual([]);
  });

  it('reports a scoped runner package', () => {
    const entry = graph({ 'entry.ts': `import { spy } from '@vitest/spy';` });

    expect(testRunnersReachableFrom(entry)).toEqual(['@vitest/spy']);
  });

  it("reports the platform's own runner module", () => {
    const entry = graph({ 'entry.ts': `import { test } from 'node:test';` });

    expect(testRunnersReachableFrom(entry)).toEqual(['node:test']);
  });

  it('reports a runner named by a dynamic import call', () => {
    const entry = graph({ 'entry.ts': `const runner = await import('vitest');` });

    expect(testRunnersReachableFrom(entry)).toEqual(['vitest']);
  });

  it('misses a runner sitting behind a package specifier', () => {
    const entry = graph({
      'entry.ts': `export { helper } from 'some-package';`,
      'some-package.ts': `import { vi } from 'vitest';\nexport const helper = vi;`,
    });

    expect(testRunnersReachableFrom(entry)).toEqual([]);
  });

  it('reads a file once when two edges name it', () => {
    const entry = graph({
      'entry.ts': `export { a } from './a.js';\nexport { b } from './b.js';`,
      'a.ts': `export { shared as a } from './shared.js';`,
      'b.ts': `export { shared as b } from './shared.js';`,
      'shared.ts': `import { vi } from 'vitest';\nexport const shared = vi;`,
    });

    expect(testRunnersReachableFrom(entry)).toEqual(['vitest']);
  });

  it('terminates on a cycle between two modules', () => {
    const entry = graph({
      'entry.ts': `import './loop.js';\nimport 'vitest';`,
      'loop.ts': `import './entry.js';`,
    });

    expect(testRunnersReachableFrom(entry)).toEqual(['vitest']);
  });
});
