import { describe, expect, it } from 'vitest';
import { MIB, TMPFS_MAGIC, mebibytes, statfsType, tmpfsShortfall } from './tmpfs.js';

/** btrfs, the filesystem a disk-backed checkout sits on here. */
const BTRFS_MAGIC = 0x91_23_68_3e;
const BLOCK_SIZE = 4096;
const REQUIRED = 64 * MIB;

/** A reading of a filesystem of `type` answering `freeBytes` free to an unprivileged writer. */
function reading(type: number, freeBytes: number): { type: number; bsize: number; bavail: number } {
  return { type, bsize: BLOCK_SIZE, bavail: freeBytes / BLOCK_SIZE };
}

describe('tmpfsShortfall', () => {
  it('accepts a tmpfs with exactly the space required', () => {
    expect(tmpfsShortfall(reading(TMPFS_MAGIC, REQUIRED), REQUIRED)).toBeUndefined();
  });

  it('refuses a tmpfs one block short of the space required', () => {
    expect(tmpfsShortfall(reading(TMPFS_MAGIC, REQUIRED - BLOCK_SIZE), REQUIRED)).toEqual({
      isTmpfs: true,
      type: TMPFS_MAGIC,
      freeBytes: REQUIRED - BLOCK_SIZE,
    });
  });

  it('counts the credit as free space', () => {
    const short = reading(TMPFS_MAGIC, REQUIRED - BLOCK_SIZE);

    expect(tmpfsShortfall(short, REQUIRED, BLOCK_SIZE)).toBeUndefined();
  });

  it('refuses a filesystem that is not tmpfs, however much room it has', () => {
    expect(tmpfsShortfall(reading(BTRFS_MAGIC, 10 * REQUIRED), REQUIRED)).toMatchObject({
      isTmpfs: false,
      type: BTRFS_MAGIC,
    });
  });

  it('refuses a reading whose free space is NaN', () => {
    expect(tmpfsShortfall(reading(TMPFS_MAGIC, Number.NaN), REQUIRED)).toMatchObject({
      isTmpfs: true,
    });
  });

  it('refuses a requirement that is NaN', () => {
    expect(tmpfsShortfall(reading(TMPFS_MAGIC, REQUIRED), Number.NaN)).toBeDefined();
  });
});

describe('mebibytes', () => {
  it('states whole mebibytes, rounded down', () => {
    expect(mebibytes(2 * MIB - 1)).toBe('1 MiB');
  });
});

describe('statfsType', () => {
  it('states a filesystem type as eight hex digits', () => {
    expect(statfsType(TMPFS_MAGIC)).toBe('0x01021994');
  });
});
