import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest';
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
  asideOwner,
  e2eOutputDir,
  findFreeAsideName,
  purgeAsideDirectories,
  resetOutputDir,
  isPurgeDirectory,
} from './e2e-clean.js';
import { RUN_CLAIM_ENV, registerRun } from './lib/claims/registry.js';
import { ramPathsFor } from './lib/stack/ram-root.js';
import type { RamRootHost } from './lib/stack/ram-root.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The run claim this file was invoked under. Registering a run inside a case
 * clears the variable on the way out, so a hook that puts back an empty string
 * leaves every later suite here — and everything else this worker goes on to
 * run — creating resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

afterAll(() => {
  // Empty string rather than absent: every reader treats an empty claim
  // variable as no claim, and a computed key cannot be deleted.
  expect(process.env[RUN_CLAIM_ENV]).toBe(inheritedRunClaim ?? '');
});

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

  describe('asideOwner', () => {
    it('reads back the run an aside was renamed by', () => {
      expect(asideOwner('test-results', 'test-results.purge-run-abc.0')).toBe('run-abc');
    });

    it('reports no owner for an aside renamed by a process holding no claim', () => {
      expect(asideOwner('test-results', 'test-results.purge-0')).toBeUndefined();
    });

    it('reports no owner for a directory that is not an aside', () => {
      expect(asideOwner('test-results', 'test-results')).toBeUndefined();
    });
  });

  describe('the claim an aside carries', () => {
    const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');
    let registryDir: string;

    beforeEach(() => {
      registryDir = mkdtempSync(path.join(os.tmpdir(), 'hushbox-aside-claim-'));
      process.env[RUN_CLAIM_ENV] = '';
    });

    afterEach(() => {
      process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
      rmSync(registryDir, { recursive: true, force: true });
    });

    function run<T>(body: () => Promise<T>): Promise<T> {
      return registerRun(
        { command: 'pnpm e2e', mode: 'e2e', slot: 4, gitCommonDir: CHECKOUT, registryDir },
        body
      );
    }

    it('names the run that renamed the directory aside', async () => {
      await run(async () => {
        const outputDir = path.join(workDir, 'test-results');
        seed(outputDir, { 'a.txt': 'a' });
        const owner = path.basename(process.env[RUN_CLAIM_ENV] ?? '');

        const aside = await findFreeAsideName(workDir, 'test-results');

        expect(asideOwner('test-results', aside)).toBe(owner);
      });
    });

    it('leaves an aside whose run still holds its claim', async () => {
      await run(async () => {
        const owner = path.basename(process.env[RUN_CLAIM_ENV] ?? '');
        const aside = `test-results.purge-${owner}.0`;
        mkdirSync(path.join(workDir, aside));

        await purgeAsideDirectories(workDir, 'test-results', { registryDir });

        expect(existsSync(path.join(workDir, aside))).toBe(true);
      });
    });

    it('removes an aside whose run died', async () => {
      let owner = '';
      await expect(
        run(() => {
          owner = path.basename(process.env[RUN_CLAIM_ENV] ?? '');
          return Promise.reject(new Error('killed'));
        })
      ).rejects.toThrow('killed');
      const aside = `test-results.purge-${owner}.0`;
      mkdirSync(path.join(workDir, aside));

      await purgeAsideDirectories(workDir, 'test-results', { registryDir });

      expect(existsSync(path.join(workDir, aside))).toBe(false);
    });

    it('removes its own aside even while its run still holds the claim', async () => {
      await run(async () => {
        const outputDir = path.join(workDir, 'test-results');
        seed(outputDir, { 'a.txt': 'a' });

        await resetOutputDir(outputDir, { registryDir });

        expect(readdirSync(workDir).filter((n) => isPurgeDirectory('test-results', n))).toEqual([]);
      });
    });

    it('reclaims an aside a run was killed before it could remove', async () => {
      let owner = '';
      await expect(
        run(() => {
          owner = path.basename(process.env[RUN_CLAIM_ENV] ?? '');
          return Promise.reject(new Error('killed'));
        })
      ).rejects.toThrow('killed');
      const aside = `test-results.purge-${owner}.0`;
      mkdirSync(path.join(workDir, aside));

      await resetOutputDir(path.join(workDir, 'test-results'), { registryDir });

      expect(existsSync(path.join(workDir, aside))).toBe(false);
    });

    it('removes an aside naming a run no claim accounts for', async () => {
      const aside = 'test-results.purge-a-run-nothing-claims.0';
      mkdirSync(path.join(workDir, aside));

      await purgeAsideDirectories(workDir, 'test-results', { registryDir });

      expect(existsSync(path.join(workDir, aside))).toBe(false);
    });

    it('removes an aside naming no run at all', async () => {
      const aside = 'test-results.purge-0';
      mkdirSync(path.join(workDir, aside));

      await purgeAsideDirectories(workDir, 'test-results', { registryDir });

      expect(existsSync(path.join(workDir, aside))).toBe(false);
    });
  });

  describe('findFreeAsideName', () => {
    // Every case here is about the index rather than the owner, and the name
    // carries no run only while this process holds no claim. Stated here
    // because it is this suite's premise; it used to arrive as the residue of a
    // neighbouring suite's teardown.
    beforeEach(() => {
      process.env[RUN_CLAIM_ENV] = '';
    });

    afterEach(() => {
      process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    });

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
      expect(existsSync(path.join(workDir, 'test-results.purge-0'))).toBe(true);
    });

    it('does nothing when the parent does not exist', async () => {
      await expect(
        purgeAsideDirectories(path.join(workDir, 'missing'), 'test-results')
      ).resolves.toBeUndefined();
    });
  });

  describe('the output directory it resolves', () => {
    /** Linux, with its RAM filesystem stood on the case's scratch directory. */
    function linuxOnScratch(): RamRootHost {
      return { platform: 'linux', parent: workDir };
    }

    it('lies in the E2E RAM root on Linux', () => {
      expect(e2eOutputDir(linuxOnScratch())).toBe(
        ramPathsFor(REPO_ROOT, linuxOnScratch())?.testResults
      );
    });

    it.each(['darwin', 'win32'] as const)(
      'is the repository’s test-results directory on %s',
      (platform) => {
        expect(e2eOutputDir({ platform, parent: workDir })).toBe(
          path.join(REPO_ROOT, 'test-results')
        );
      }
    );

    it('lies in the E2E RAM root of the checkout it is given, on Linux', () => {
      const checkout = path.join(workDir, 'another-checkout');

      expect(e2eOutputDir(linuxOnScratch(), checkout)).toBe(
        ramPathsFor(checkout, linuxOnScratch())?.testResults
      );
    });

    it('is the given checkout’s test-results directory off Linux', () => {
      const checkout = path.join(workDir, 'another-checkout');

      expect(e2eOutputDir({ platform: 'darwin', parent: workDir }, checkout)).toBe(
        path.join(checkout, 'test-results')
      );
    });

    it('is the one the reset clears on Linux', async () => {
      const outputDir = e2eOutputDir(linuxOnScratch());
      seed(outputDir, { 'chat-send-chromium/trace.zip': 'x' });

      await resetOutputDir(e2eOutputDir(linuxOnScratch()));

      expect(existsSync(path.join(outputDir, 'chat-send-chromium'))).toBe(false);
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

    it('leaves a still-locked aside standing rather than aborting the reset', async () => {
      const outputDir = path.join(workDir, 'test-results');
      seed(outputDir, { 'sub/trace.bin': 'x' });
      vi.mocked(fsp.rm).mockRejectedValueOnce(new Error('EBUSY'));

      await expect(resetOutputDir(outputDir)).resolves.toBeUndefined();

      expect(readdirSync(workDir).filter((n) => isPurgeDirectory('test-results', n))).toHaveLength(
        1
      );
    });

    it('leaves no aside behind when the run that renamed it exits cleanly', async () => {
      const outputDir = path.join(workDir, 'test-results');

      for (let pass = 0; pass < 3; pass += 1) {
        seed(outputDir, { 'sub/trace.bin': 'x' });
        await resetOutputDir(outputDir);
      }

      expect(readdirSync(workDir).filter((n) => isPurgeDirectory('test-results', n))).toEqual([]);
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
