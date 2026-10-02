import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

import { readFile, readdir } from 'node:fs/promises';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import { attributeLiveGroup } from './process-groups.js';

const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);

/** The `/proc` path a read was asked for; every call under test passes a string. */
function procPath(file: unknown): string {
  return typeof file === 'string' ? file : '';
}

/** A `/proc/<pid>/stat` line placing its process in `pgid`. */
function statLine(pid: number, pgid: number): string {
  return `${String(pid)} (probe) S 1 ${String(pgid)} ${String(pgid)} 0 -1 0`;
}

describe('attributing a live process group where the kernel cannot be asked', () => {
  const RUN_DIR = '/run/record/probe';
  const PGID = 4242;

  it('leaves a group unanswerable when the process table cannot be listed', async () => {
    mockReaddir.mockRejectedValueOnce(new Error('proc is not mounted'));

    await expect(attributeLiveGroup(PGID, RUN_DIR, 'linux')).resolves.toBe('unanswerable');
  });

  it('leaves a group unanswerable when a member environment cannot be read', async () => {
    // @ts-expect-error -- the overloaded signature resolves to the Buffer form here
    mockReaddir.mockResolvedValueOnce(['7', 'self']);
    mockReadFile.mockImplementation((file) => {
      const name = procPath(file);
      if (name.endsWith('/7/stat')) return Promise.resolve(statLine(7, PGID));
      if (name.endsWith('/7/environ')) return Promise.reject(new Error('not this user'));
      return Promise.reject(new Error(`unexpected read of ${name}`));
    });

    try {
      await expect(attributeLiveGroup(PGID, RUN_DIR, 'linux')).resolves.toBe('unanswerable');
    } finally {
      mockReadFile.mockReset();
    }
  });

  it('attributes a group to this run when a member carries the run record', async () => {
    // @ts-expect-error -- the overloaded signature resolves to the Buffer form here
    mockReaddir.mockResolvedValueOnce(['7']);
    mockReadFile.mockImplementation((file) => {
      const name = procPath(file);
      if (name.endsWith('/7/stat')) return Promise.resolve(statLine(7, PGID));
      if (name.endsWith('/7/environ')) return Promise.resolve(`${RUN_CLAIM_ENV}=${RUN_DIR}\0`);
      return Promise.reject(new Error(`unexpected read of ${name}`));
    });

    try {
      await expect(attributeLiveGroup(PGID, RUN_DIR, 'linux')).resolves.toBe('this-run');
    } finally {
      mockReadFile.mockReset();
    }
  });
});
