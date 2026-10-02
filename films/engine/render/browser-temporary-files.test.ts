import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { MIB, TMPFS_MAGIC } from '@hushbox/scripts/lib/tmpfs';

import {
  BROWSER_TEMPORARY_BYTES,
  browserTemporaryParent,
  browserTemporaryRefusal,
} from './browser-temporary-files.js';
import { FilmRenderError } from './film-error.js';

/** btrfs, the filesystem the OS temp directory sits on here. */
const BTRFS_MAGIC = 0x91_23_68_3e;
const BLOCK_SIZE = 4096;
const SHM = path.join(path.sep, 'dev', 'shm');

/** A reading of a filesystem of `type` answering `freeBytes` free to an unprivileged writer. */
function reading(type: number, freeBytes: number): { type: number; bsize: number; bavail: number } {
  return { type, bsize: BLOCK_SIZE, bavail: freeBytes / BLOCK_SIZE };
}

describe('BROWSER_TEMPORARY_BYTES', () => {
  it('asks 64 MiB for a render browser', () => {
    expect(BROWSER_TEMPORARY_BYTES).toBe(64 * MIB);
  });
});

describe('browserTemporaryParent', () => {
  it('makes render browsers their temporary directory on /dev/shm on Linux', () => {
    expect(browserTemporaryParent('linux')).toBe(SHM);
  });

  it('leaves macOS on the OS temporary directory', () => {
    expect(browserTemporaryParent('darwin')).toBeUndefined();
  });

  it('leaves Windows on the OS temporary directory', () => {
    expect(browserTemporaryParent('win32')).toBeUndefined();
  });
});

describe('browserTemporaryRefusal', () => {
  it('accepts a tmpfs with exactly 64 MiB free', () => {
    expect(
      browserTemporaryRefusal('engine-render', SHM, reading(TMPFS_MAGIC, BROWSER_TEMPORARY_BYTES))
    ).toBeUndefined();
  });

  it('refuses a tmpfs one block under 64 MiB free', () => {
    const refusal = browserTemporaryRefusal(
      'engine-render',
      SHM,
      reading(TMPFS_MAGIC, BROWSER_TEMPORARY_BYTES - BLOCK_SIZE)
    );

    expect(refusal).toBeInstanceOf(FilmRenderError);
  });

  it('names the film, the directory, its free space and the need when a tmpfs is short', () => {
    const refusal = browserTemporaryRefusal('engine-render', SHM, reading(TMPFS_MAGIC, 10 * MIB));

    expect(refusal?.message).toBe(
      `engine-render: browser-temporary-files: a render browser's temporary directory needs 64 MiB free on a tmpfs, and ${SHM} is tmpfs with 10 MiB free. Raise the shared-memory size (for a container, its shm size), and re-run.`
    );
  });

  it('refuses a filesystem that is not tmpfs, naming its type and free space', () => {
    const refusal = browserTemporaryRefusal('engine-render', SHM, reading(BTRFS_MAGIC, 1024 * MIB));

    expect(refusal?.message).toBe(
      `engine-render: browser-temporary-files: a render browser's temporary directory needs 64 MiB free on a tmpfs, and ${SHM} is not tmpfs (statfs type 0x9123683e), with 1024 MiB free. Mount a tmpfs at ${SHM}, and re-run.`
    );
  });

  it('refuses a reading whose free space is NaN', () => {
    expect(
      browserTemporaryRefusal('engine-render', SHM, reading(TMPFS_MAGIC, Number.NaN))
    ).toBeInstanceOf(FilmRenderError);
  });
});
