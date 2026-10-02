import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RENAME_RETRY_DELAYS_MS, renameWithRetry, renameWithRetrySync } from './atomic-rename.ts';
import type { Mock } from 'vitest';

function permissionDenied(): NodeJS.ErrnoException {
  return Object.assign(new Error('rename EPERM'), { code: 'EPERM' });
}

/** A rename that answers `EPERM` the first `failures` times and then succeeds. */
function failingRename(failures: number): Mock<(from: string, to: string) => void> {
  let seen = 0;
  return vi.fn(() => {
    seen += 1;
    if (seen <= failures) throw permissionDenied();
  });
}

describe('renameWithRetrySync', () => {
  it('moves the file when nothing holds the destination', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-rename-'));
    try {
      const staging = path.join(directory, 'staging');
      const target = path.join(directory, 'target');
      await writeFile(staging, 'contents');

      renameWithRetrySync(staging, target);

      await expect(readFile(target, 'utf8')).resolves.toBe('contents');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renames once when the first attempt succeeds', () => {
    const rename = vi.fn();
    const sleep = vi.fn();

    renameWithRetrySync('staging', 'target', { rename, sleep });

    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a denied rename until it goes through', () => {
    const rename = failingRename(2);
    const sleep = vi.fn();

    renameWithRetrySync('staging', 'target', { rename, sleep });

    expect(rename).toHaveBeenCalledTimes(3);
    expect(rename).toHaveBeenLastCalledWith('staging', 'target');
  });

  it('waits a growing grace period between attempts', () => {
    const rename = failingRename(2);
    const sleep = vi.fn();

    renameWithRetrySync('staging', 'target', { rename, sleep });

    expect(sleep.mock.calls.flat()).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('waits without an injected sleep, so the grace period is not test-only', () => {
    const rename = failingRename(1);

    renameWithRetrySync('staging', 'target', { rename });

    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('gives the denial back once the grace period is spent', () => {
    const rename = vi.fn(() => {
      throw permissionDenied();
    });
    const sleep = vi.fn();

    expect(() => {
      renameWithRetrySync('staging', 'target', { rename, sleep });
    }).toThrow(/EPERM/);
    expect(rename).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length + 1);
  });

  it('reports any other failure at once, without spending the grace period', () => {
    const rename = vi.fn(() => {
      throw Object.assign(new Error('rename ENOENT'), { code: 'ENOENT' });
    });
    const sleep = vi.fn();

    expect(() => {
      renameWithRetrySync('staging', 'target', { rename, sleep });
    }).toThrow(/ENOENT/);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('renameWithRetry', () => {
  it('moves the file when nothing holds the destination', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'atomic-rename-'));
    try {
      const staging = path.join(directory, 'staging');
      const target = path.join(directory, 'target');
      await writeFile(staging, 'contents');

      await renameWithRetry(staging, target);

      await expect(readFile(target, 'utf8')).resolves.toBe('contents');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renames once when the first attempt succeeds', async () => {
    const rename = vi.fn(() => Promise.resolve());
    const sleep = vi.fn(() => Promise.resolve());

    await renameWithRetry('staging', 'target', { rename, sleep });

    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a denied rename until it goes through', async () => {
    let seen = 0;
    const rename = vi.fn(() => {
      seen += 1;
      return seen <= 2 ? Promise.reject(permissionDenied()) : Promise.resolve();
    });
    const sleep = vi.fn(() => Promise.resolve());

    await renameWithRetry('staging', 'target', { rename, sleep });

    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.flat()).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('waits without an injected sleep, so the grace period is not test-only', async () => {
    let seen = 0;
    const rename = vi.fn(() => {
      seen += 1;
      return seen <= 1 ? Promise.reject(permissionDenied()) : Promise.resolve();
    });

    await renameWithRetry('staging', 'target', { rename });

    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('gives the denial back once the grace period is spent', async () => {
    const rename = vi.fn(() => Promise.reject(permissionDenied()));
    const sleep = vi.fn(() => Promise.resolve());

    await expect(renameWithRetry('staging', 'target', { rename, sleep })).rejects.toThrow(/EPERM/);
    expect(rename).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length + 1);
  });

  it('reports any other failure at once, without spending the grace period', async () => {
    const rename = vi.fn(() =>
      Promise.reject(Object.assign(new Error('rename ENOENT'), { code: 'ENOENT' }))
    );
    const sleep = vi.fn(() => Promise.resolve());

    await expect(renameWithRetry('staging', 'target', { rename, sleep })).rejects.toThrow(/ENOENT/);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
