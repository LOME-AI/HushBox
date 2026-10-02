import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RENAME_RETRY_DELAYS_MS } from '@hushbox/shared/atomic-rename';
import { TEST_DAY_START, freezeClock } from '@hushbox/shared/test-time';
import { writeAtomically } from './atomic-write.js';
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

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'cassette-atomic-'));
}

/** A rename that succeeds and keeps the staging name it was handed. */
function stagingNames(): { rename: Mock<(from: string, to: string) => void>; seen: string[] } {
  const seen: string[] = [];
  return {
    rename: vi.fn((from: string) => {
      seen.push(from);
    }),
    seen,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('writeAtomically', () => {
  it('lands the body at the path it was given', () => {
    const directory = scratch();
    try {
      const file = path.join(directory, 'nested', 'recording.json');

      writeAtomically(file, 'contents');

      expect(readFileSync(file, 'utf8')).toBe('contents');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renames once when the destination is free', () => {
    const directory = scratch();
    try {
      const rename = vi.fn();
      const sleep = vi.fn();

      writeAtomically(path.join(directory, 'recording.json'), 'contents', { rename, sleep });

      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retries a denied rename until it goes through', () => {
    const directory = scratch();
    try {
      const rename = failingRename(2);
      const sleep = vi.fn();

      writeAtomically(path.join(directory, 'recording.json'), 'contents', { rename, sleep });

      expect(rename).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.flat()).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits without an injected sleep, so the grace period is not test-only', () => {
    const directory = scratch();
    try {
      const rename = failingRename(1);

      writeAtomically(path.join(directory, 'recording.json'), 'contents', { rename });

      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives the denial back once the grace period is spent', () => {
    const directory = scratch();
    try {
      const rename = vi.fn(() => {
        throw permissionDenied();
      });
      const sleep = vi.fn();

      expect(() => {
        writeAtomically(path.join(directory, 'recording.json'), 'contents', { rename, sleep });
      }).toThrow(/EPERM/);
      expect(rename).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length + 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stages under a name carrying no process identifier', () => {
    const directory = scratch();
    try {
      const { rename, seen } = stagingNames();

      writeAtomically(path.join(directory, 'recording.json'), 'contents', { rename });

      expect(seen[0]).not.toContain(String(process.pid));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stages under a name carrying no clock reading', () => {
    const directory = scratch();
    try {
      freezeClock(TEST_DAY_START);
      const { rename, seen } = stagingNames();

      writeAtomically(path.join(directory, 'recording.json'), 'contents', { rename });

      expect(seen[0]).not.toContain(String(TEST_DAY_START));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // The clock is pinned so that the only variation left is the one the staging
  // name is supposed to carry: two writers in one millisecond must still differ.
  it('mints a staging name no second write repeats', () => {
    const directory = scratch();
    try {
      freezeClock(TEST_DAY_START);
      const { rename, seen } = stagingNames();
      const file = path.join(directory, 'recording.json');

      writeAtomically(file, 'contents', { rename });
      writeAtomically(file, 'contents', { rename });

      expect(seen[0]).not.toBe(seen[1]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports any other failure at once, without spending the grace period', () => {
    const directory = scratch();
    try {
      const rename = vi.fn(() => {
        throw Object.assign(new Error('rename ENOSPC'), { code: 'ENOSPC' });
      });
      const sleep = vi.fn();

      expect(() => {
        writeAtomically(path.join(directory, 'recording.json'), 'contents', { rename, sleep });
      }).toThrow(/ENOSPC/);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
