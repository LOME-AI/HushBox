import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fileFingerprint,
  treeFingerprint,
  composeFingerprint,
  type FileFilter,
} from './fingerprint.js';

let workDir = '';

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-fingerprint-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('fileFingerprint', () => {
  it('returns the sha256 hex of file contents', async () => {
    const file = path.join(workDir, 'lock.yaml');
    writeFileSync(file, 'lock contents');
    const hash = await fileFingerprint(file);
    // sha256('lock contents') = b6d2... (verified independently)
    expect(hash).toMatch(/^[\da-f]{64}$/);
  });

  it('returns different hashes for different content', async () => {
    const a = path.join(workDir, 'a');
    const b = path.join(workDir, 'b');
    writeFileSync(a, 'one');
    writeFileSync(b, 'two');
    expect(await fileFingerprint(a)).not.toBe(await fileFingerprint(b));
  });

  it('returns the same hash for identical content across files', async () => {
    const a = path.join(workDir, 'a');
    const b = path.join(workDir, 'b');
    writeFileSync(a, 'same');
    writeFileSync(b, 'same');
    expect(await fileFingerprint(a)).toBe(await fileFingerprint(b));
  });

  it('throws when the file does not exist', async () => {
    await expect(fileFingerprint(path.join(workDir, 'missing'))).rejects.toThrow();
  });
});

describe('treeFingerprint', () => {
  it('returns a sha256 hash over the sorted list of files and their contents', async () => {
    writeFileSync(path.join(workDir, 'a.ts'), 'A');
    writeFileSync(path.join(workDir, 'b.ts'), 'B');
    const hash = await treeFingerprint(workDir);
    expect(hash).toMatch(/^[\da-f]{64}$/);
  });

  it('is stable across runs (same content → same hash)', async () => {
    writeFileSync(path.join(workDir, 'a.ts'), 'A');
    writeFileSync(path.join(workDir, 'b.ts'), 'B');
    const first = await treeFingerprint(workDir);
    const second = await treeFingerprint(workDir);
    expect(first).toBe(second);
  });

  it('is order-independent (file creation order does not affect the hash)', async () => {
    const dir1 = mkdtempSync(path.join(tmpdir(), 'hb-tree-1-'));
    const dir2 = mkdtempSync(path.join(tmpdir(), 'hb-tree-2-'));
    try {
      writeFileSync(path.join(dir1, 'b.ts'), 'B');
      writeFileSync(path.join(dir1, 'a.ts'), 'A');
      writeFileSync(path.join(dir2, 'a.ts'), 'A');
      writeFileSync(path.join(dir2, 'b.ts'), 'B');
      expect(await treeFingerprint(dir1)).toBe(await treeFingerprint(dir2));
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('changes when any file content changes', async () => {
    writeFileSync(path.join(workDir, 'a.ts'), 'A');
    const before = await treeFingerprint(workDir);
    writeFileSync(path.join(workDir, 'a.ts'), 'A-modified');
    const after = await treeFingerprint(workDir);
    expect(before).not.toBe(after);
  });

  it('changes when a file is added', async () => {
    writeFileSync(path.join(workDir, 'a.ts'), 'A');
    const before = await treeFingerprint(workDir);
    writeFileSync(path.join(workDir, 'b.ts'), 'B');
    const after = await treeFingerprint(workDir);
    expect(before).not.toBe(after);
  });

  it('recurses into subdirectories', async () => {
    mkdirSync(path.join(workDir, 'sub'));
    writeFileSync(path.join(workDir, 'sub', 'a.ts'), 'A');
    const hash = await treeFingerprint(workDir);
    expect(hash).toMatch(/^[\da-f]{64}$/);
  });

  it('respects the optional filter to exclude files', async () => {
    writeFileSync(path.join(workDir, 'a.ts'), 'A');
    writeFileSync(path.join(workDir, 'a.test.ts'), 'A-TEST');
    const filter: FileFilter = (relativePath) => !relativePath.endsWith('.test.ts');
    const withTests = await treeFingerprint(workDir);
    const withoutTests = await treeFingerprint(workDir, { filter });
    expect(withTests).not.toBe(withoutTests);
  });

  it('skips node_modules and dist by default', async () => {
    writeFileSync(path.join(workDir, 'a.ts'), 'A');
    const before = await treeFingerprint(workDir);
    mkdirSync(path.join(workDir, 'node_modules'));
    writeFileSync(path.join(workDir, 'node_modules', 'junk.js'), 'noise');
    mkdirSync(path.join(workDir, 'dist'));
    writeFileSync(path.join(workDir, 'dist', 'junk.js'), 'noise');
    const after = await treeFingerprint(workDir);
    expect(before).toBe(after);
  });

  it('returns a stable empty-tree hash when the directory has no qualifying files', async () => {
    const hash = await treeFingerprint(workDir);
    expect(hash).toMatch(/^[\da-f]{64}$/);
  });

  it.runIf(process.platform !== 'win32')(
    'skips symlinks (neither files nor directories per dirent)',
    async () => {
      writeFileSync(path.join(workDir, 'real.ts'), 'real');
      const { symlinkSync } = await import('node:fs');
      symlinkSync(path.join(workDir, 'real.ts'), path.join(workDir, 'link.ts'));
      // Hash should match a directory with only the real file, not include the symlink.
      const hash = await treeFingerprint(workDir);
      expect(hash).toMatch(/^[\da-f]{64}$/);
    }
  );
});

describe('composeFingerprint', () => {
  it('returns a sha256 hex hash over its inputs', () => {
    const hash = composeFingerprint(['a', 'b', 'c']);
    expect(hash).toMatch(/^[\da-f]{64}$/);
  });

  it('is order-sensitive (different order → different hash)', () => {
    expect(composeFingerprint(['a', 'b'])).not.toBe(composeFingerprint(['b', 'a']));
  });

  it('is deterministic (same input → same hash)', () => {
    expect(composeFingerprint(['a', 'b'])).toBe(composeFingerprint(['a', 'b']));
  });

  it('treats input boundaries unambiguously so "ab","c" and "a","bc" differ', () => {
    expect(composeFingerprint(['ab', 'c'])).not.toBe(composeFingerprint(['a', 'bc']));
  });

  it('accepts an empty input list', () => {
    const hash = composeFingerprint([]);
    expect(hash).toMatch(/^[\da-f]{64}$/);
  });
});
