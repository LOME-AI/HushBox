import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RENAME_RETRY_DELAYS_MS } from '@hushbox/shared/atomic-rename';
import { atomicWrite } from './atomic-write.ts';
import type { Mock } from 'vitest';

function permissionDenied(): NodeJS.ErrnoException {
  return Object.assign(new Error('rename EPERM'), { code: 'EPERM' });
}

/** A rename that answers `EPERM` the first `failures` times and then succeeds. */
function failingRename(failures: number): Mock<(from: string, to: string) => Promise<void>> {
  let seen = 0;
  return vi.fn(() => {
    seen += 1;
    return seen <= failures ? Promise.reject(permissionDenied()) : Promise.resolve();
  });
}

describe('atomicWrite', () => {
  it('lands the text at the path it was given', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-atomic-'));
    try {
      const file = path.join(directory, 'finding.md');

      await atomicWrite(file, 'contents');

      await expect(fs.readFile(file, 'utf8')).resolves.toBe('contents');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('renames once when the destination is free', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-atomic-'));
    try {
      const rename = vi.fn(() => Promise.resolve());
      const sleep = vi.fn(() => Promise.resolve());

      await atomicWrite(path.join(directory, 'finding.md'), 'contents', { rename, sleep });

      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('retries a denied rename until it goes through', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-atomic-'));
    try {
      const rename = failingRename(2);
      const sleep = vi.fn(() => Promise.resolve());

      await atomicWrite(path.join(directory, 'finding.md'), 'contents', { rename, sleep });

      expect(rename).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.flat()).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('waits without an injected sleep, so the grace period is not test-only', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-atomic-'));
    try {
      const rename = failingRename(1);

      await atomicWrite(path.join(directory, 'finding.md'), 'contents', { rename });

      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('gives the denial back once the grace period is spent', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-atomic-'));
    try {
      const rename = vi.fn(() => Promise.reject(permissionDenied()));
      const sleep = vi.fn(() => Promise.resolve());

      await expect(
        atomicWrite(path.join(directory, 'finding.md'), 'contents', { rename, sleep })
      ).rejects.toThrow(/EPERM/);
      expect(rename).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length + 1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('reports any other failure at once, without spending the grace period', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-atomic-'));
    try {
      const rename = vi.fn(() =>
        Promise.reject(Object.assign(new Error('rename ENOSPC'), { code: 'ENOSPC' }))
      );
      const sleep = vi.fn(() => Promise.resolve());

      await expect(
        atomicWrite(path.join(directory, 'finding.md'), 'contents', { rename, sleep })
      ).rejects.toThrow(/ENOSPC/);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
