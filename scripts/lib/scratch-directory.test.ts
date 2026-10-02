import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withScratchDirectory } from './scratch-directory.js';

describe('withScratchDirectory', () => {
  it('runs the body against a directory that exists', async () => {
    let seen = '';
    await withScratchDirectory('hushbox-scratch-test-', (directory) => {
      seen = directory;
      expect(existsSync(directory)).toBe(true);
      return Promise.resolve();
    });
    expect(seen).not.toBe('');
  });

  it('names the directory after the prefix it was given', async () => {
    let seen = '';
    await withScratchDirectory('hushbox-scratch-test-', (directory) => {
      seen = directory;
      return Promise.resolve();
    });
    expect(seen).toContain('hushbox-scratch-test-');
  });

  it('returns what the body returned', async () => {
    await expect(
      withScratchDirectory('hushbox-scratch-test-', () => Promise.resolve('captured'))
    ).resolves.toBe('captured');
  });

  it('removes the directory once the body is done', async () => {
    let seen = '';
    await withScratchDirectory('hushbox-scratch-test-', (directory) => {
      seen = directory;
      return Promise.resolve();
    });
    expect(existsSync(seen)).toBe(false);
  });

  it('removes the directory when the body throws', async () => {
    let seen = '';
    await expect(
      withScratchDirectory('hushbox-scratch-test-', (directory) => {
        seen = directory;
        return Promise.reject(new Error('body failed'));
      })
    ).rejects.toThrow('body failed');
    expect(existsSync(seen)).toBe(false);
  });

  it('removes a directory the body left files in', async () => {
    let seen = '';
    await withScratchDirectory('hushbox-scratch-test-', async (directory) => {
      seen = directory;
      await writeFile(path.join(directory, 'left-behind.txt'), 'contents');
    });
    expect(existsSync(seen)).toBe(false);
  });

  // `packages/config/eslint-extensions/rules/money-brand.test.mjs` links the
  // repository's install into its scratch tree so the type checker's upward walk
  // finds it, which is safe only because removal unlinks a symlink instead of
  // descending it. A cleanup rewritten as a recursive walk would delete the
  // install, and would announce it much later in an unrelated command. The link
  // target below is created by this test; linking the real install here would be
  // the loss this case exists to prevent.
  it('unlinks a symlink in the tree rather than descending into its target', async () => {
    await withScratchDirectory('hushbox-scratch-test-target-', async (target) => {
      const survivor = path.join(target, 'survivor.txt');
      await writeFile(survivor, 'contents');

      let seen = '';
      await withScratchDirectory('hushbox-scratch-test-', async (directory) => {
        seen = directory;
        await symlink(target, path.join(directory, 'linked'), 'junction');
      });

      expect(existsSync(seen)).toBe(false);
      expect(existsSync(survivor)).toBe(true);
      expect(await readFile(survivor, 'utf8')).toBe('contents');
    });
  });
});
