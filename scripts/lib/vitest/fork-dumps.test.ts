import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FORK_DUMP_DIRECTORY,
  FORK_DUMP_ROOT_ENV,
  forkDumpDirectoryName,
  requireForkDumpRoot,
} from './fork-dumps.js';

const REPORTS_DIRECTORY = path.join(path.sep, 'repo', 'coverage', 'run-a-b');
const ROOT = path.join(REPORTS_DIRECTORY, FORK_DUMP_DIRECTORY);

describe('FORK_DUMP_DIRECTORY', () => {
  it('is a single path segment, so a root is one join from a reports directory', () => {
    expect(FORK_DUMP_DIRECTORY).not.toContain('/');
    expect(FORK_DUMP_DIRECTORY).not.toContain(path.sep);
  });
});

describe('requireForkDumpRoot', () => {
  it('returns the root the host published', () => {
    expect(requireForkDumpRoot({ [FORK_DUMP_ROOT_ENV]: ROOT })).toBe(ROOT);
  });

  it('throws rather than writing somewhere no reclaim reaches when nothing published one', () => {
    expect(() => requireForkDumpRoot({})).toThrow(FORK_DUMP_ROOT_ENV);
  });

  it('treats an empty value as no value', () => {
    expect(() => requireForkDumpRoot({ [FORK_DUMP_ROOT_ENV]: '' })).toThrow(FORK_DUMP_ROOT_ENV);
  });
});

describe('forkDumpDirectoryName', () => {
  it('is one path segment', () => {
    const name = forkDumpDirectoryName(1234, 'e6e6');
    expect(name).not.toContain('/');
    expect(name).not.toContain(path.sep);
  });

  it('separates two forks that recycled one pid', () => {
    expect(forkDumpDirectoryName(1234, 'e6e6')).not.toBe(forkDumpDirectoryName(1234, 'f7f7'));
  });

  it('separates two forks of one run', () => {
    expect(forkDumpDirectoryName(1234, 'e6e6')).not.toBe(forkDumpDirectoryName(5678, 'e6e6'));
  });
});
