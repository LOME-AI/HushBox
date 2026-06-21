import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findFreeAsideName,
  purgeAsideDirectories,
  resetOutputDir,
  isPurgeDirectory,
} from './e2e-clean.js';

// Auto-spy keeps the real fs implementation (so the integration tests run
// against a real temp dir) while letting one test force `rm` to reject.
vi.mock('node:fs/promises', { spy: true });

describe('e2e-clean', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-clean-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  const seed = (dir: string, files: Record<string, string>): void => {
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(dir, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
  };

  describe('isPurgeDirectory', () => {
    it('matches the base name plus the purge prefix', () => {
      expect(isPurgeDirectory('test-results', 'test-results.purge-0')).toBe(true);
      expect(isPurgeDirectory('test-results', 'test-results.purge-7')).toBe(true);
    });

    it('rejects the base dir itself and unrelated names', () => {
      expect(isPurgeDirectory('test-results', 'test-results')).toBe(false);
      expect(isPurgeDirectory('test-results', 'test-results-notes.md')).toBe(false);
      expect(isPurgeDirectory('test-results', 'other')).toBe(false);
    });
  });

  describe('findFreeAsideName', () => {
    it('returns index 0 when no aside dirs exist', async () => {
      expect(await findFreeAsideName(workDir, 'test-results')).toBe('test-results.purge-0');
    });

    it('skips occupied indices', async () => {
      mkdirSync(path.join(workDir, 'test-results.purge-0'));
      mkdirSync(path.join(workDir, 'test-results.purge-1'));
      expect(await findFreeAsideName(workDir, 'test-results')).toBe('test-results.purge-2');
    });

    it('returns index 0 when the parent does not exist', async () => {
      expect(await findFreeAsideName(path.join(workDir, 'missing'), 'test-results')).toBe(
        'test-results.purge-0'
      );
    });
  });

  describe('purgeAsideDirectories', () => {
    it('removes every aside dir and leaves the base dir untouched', async () => {
      mkdirSync(path.join(workDir, 'test-results'));
      mkdirSync(path.join(workDir, 'test-results.purge-0'));
      mkdirSync(path.join(workDir, 'test-results.purge-3'));

      await purgeAsideDirectories(workDir, 'test-results');

      expect(existsSync(path.join(workDir, 'test-results'))).toBe(true);
      expect(existsSync(path.join(workDir, 'test-results.purge-0'))).toBe(false);
      expect(existsSync(path.join(workDir, 'test-results.purge-3'))).toBe(false);
    });

    it('swallows removal errors so a still-locked aside cannot abort the run', async () => {
      mkdirSync(path.join(workDir, 'test-results.purge-0'));
      vi.mocked(fsp.rm).mockRejectedValueOnce(new Error('EBUSY'));

      await expect(purgeAsideDirectories(workDir, 'test-results')).resolves.toBeUndefined();
    });

    it('does nothing when the parent does not exist', async () => {
      await expect(
        purgeAsideDirectories(path.join(workDir, 'missing'), 'test-results')
      ).resolves.toBeUndefined();
    });
  });

  describe('resetOutputDir', () => {
    it('frees the output dir by moving its contents aside', async () => {
      const outputDir = path.join(workDir, 'test-results');
      seed(outputDir, { 'sub/trace.bin': 'x' });

      await resetOutputDir(outputDir);

      // The original tree (including the subdir) is gone; no asides linger.
      expect(existsSync(path.join(outputDir, 'sub'))).toBe(false);
      expect(readdirSync(workDir).filter((n) => isPurgeDirectory('test-results', n))).toHaveLength(
        0
      );
    });

    it('preserves .last-run.json so --last-failed keeps working', async () => {
      const outputDir = path.join(workDir, 'test-results');
      seed(outputDir, {
        '.last-run.json': '{"status":"failed","failedTests":["abc"]}',
        'sub/trace.bin': 'x',
      });

      await resetOutputDir(outputDir);

      expect(existsSync(path.join(outputDir, '.last-run.json'))).toBe(true);
      expect(JSON.parse(readFileSync(path.join(outputDir, '.last-run.json'), 'utf8'))).toEqual({
        status: 'failed',
        failedTests: ['abc'],
      });
      // The stale subdir did not survive the reset.
      expect(existsSync(path.join(outputDir, 'sub'))).toBe(false);
    });

    it('does not recreate the output dir when there is no .last-run.json', async () => {
      const outputDir = path.join(workDir, 'test-results');
      seed(outputDir, { 'sub/trace.bin': 'x' });

      await resetOutputDir(outputDir);

      expect(existsSync(outputDir)).toBe(false);
    });

    it('is a no-op when the output dir is absent', async () => {
      const outputDir = path.join(workDir, 'test-results');
      await expect(resetOutputDir(outputDir)).resolves.toBeUndefined();
      expect(existsSync(outputDir)).toBe(false);
    });

    it('purges a pre-existing aside left by an earlier run', async () => {
      const outputDir = path.join(workDir, 'test-results');
      seed(outputDir, { 'a.txt': 'a' });
      mkdirSync(path.join(workDir, 'test-results.purge-0'));

      await resetOutputDir(outputDir);

      expect(readdirSync(workDir).filter((n) => isPurgeDirectory('test-results', n))).toHaveLength(
        0
      );
    });

    it('still frees the output dir while a file inside is held open', async () => {
      const outputDir = path.join(workDir, 'test-results');
      seed(outputDir, { 'sub/trace.bin': 'x'.repeat(64) });
      const handle = await fsp.open(path.join(outputDir, 'sub/trace.bin'), 'r');
      try {
        await expect(resetOutputDir(outputDir)).resolves.toBeUndefined();
        expect(existsSync(outputDir)).toBe(false);
      } finally {
        await handle.close();
      }
    });
  });
});
