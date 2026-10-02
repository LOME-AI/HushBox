import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { resolveGitCommonDir } from './git-checkout.js';

const mockExeca = vi.mocked(execa);

describe('resolveGitCommonDir', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('resolves the common directory git prints relative to the queried directory', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '.git\n' } as never);

    await expect(resolveGitCommonDir('/repo/project')).resolves.toBe('/repo/project/.git');
    expect(mockExeca).toHaveBeenCalledWith('git', [
      '-C',
      '/repo/project',
      'rev-parse',
      '--git-common-dir',
    ]);
  });

  it('keeps an absolute common directory as git printed it', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '/repo/project/.git\n' } as never);

    await expect(resolveGitCommonDir('/repo/worktrees/feature-a')).resolves.toBe(
      '/repo/project/.git'
    );
  });

  it('returns null when the directory is gone or is not a git checkout', async () => {
    mockExeca.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(resolveGitCommonDir('/repo/worktrees/deleted')).resolves.toBeNull();
  });

  it('returns null when git prints nothing', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '  \n' } as never);

    await expect(resolveGitCommonDir('/repo/project')).resolves.toBeNull();
  });

  /**
   * The value this returns is what a run claim records as its checkout's
   * identity, and every reclaimer that asks whether a claim is this checkout's
   * compares it as a string. A checkout reached through a symlink has two
   * absolute spellings, so anchoring git's relative answer to the caller's own
   * spelling would give one checkout two identities — and a `pnpm clean`
   * entered by one spelling would not see the live run entered by the other.
   */
  describe('a checkout reached through a symlink', () => {
    let root = '';

    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'hushbox-git-checkout-'));
      mkdirSync(path.join(root, 'real', 'checkout'), { recursive: true });
      symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('gives one identity whichever spelling the caller used', async () => {
      mockExeca.mockResolvedValue({ stdout: '.git\n' } as never);

      const throughLink = await resolveGitCommonDir(path.join(root, 'link', 'checkout'));
      const throughRealPath = await resolveGitCommonDir(path.join(root, 'real', 'checkout'));

      expect(throughLink).toBe(throughRealPath);
    });

    it('gives one identity when git prints the common directory absolutely', async () => {
      const worktree = path.join(root, 'real', 'checkout');
      mockExeca.mockResolvedValueOnce({
        stdout: `${path.join(root, 'link', 'checkout', '.git')}\n`,
      } as never);
      const throughLink = await resolveGitCommonDir(worktree);

      mockExeca.mockResolvedValueOnce({
        stdout: `${path.join(root, 'real', 'checkout', '.git')}\n`,
      } as never);
      const throughRealPath = await resolveGitCommonDir(worktree);

      expect(throughLink).toBe(throughRealPath);
    });
  });
});
