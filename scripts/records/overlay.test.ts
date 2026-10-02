import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childEnvironment, git, gitResult, overlayDirectory, overlayGit } from './overlay.js';

const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'records-overlay-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('childEnvironment', () => {
  it('drops every variable that points git at a repository', () => {
    const given: NodeJS.ProcessEnv = Object.fromEntries(
      REPOSITORY_VARIABLES.map((name) => [name, path.join(sandbox, name)])
    );
    expect(Object.keys(childEnvironment(given))).toEqual([]);
  });

  it('keeps every other variable', () => {
    expect(childEnvironment({ GIT_DIR: sandbox, PATH: sandbox })).toEqual({ PATH: sandbox });
  });
});

describe('overlayDirectory', () => {
  it('is .records.git at the root', () => {
    expect(overlayDirectory(sandbox)).toBe(path.join(sandbox, '.records.git'));
  });
});

describe('git', () => {
  it('returns the output of a command that succeeds', async () => {
    await expect(git(sandbox, ['--version'])).resolves.toMatch(/^git version \S+$/u);
  });

  it('names the step of a command that fails', async () => {
    await expect(git(sandbox, ['cat-file', '-e', 'absent'], 'find the root')).rejects.toThrow(
      /^records: find the root failed: /u
    );
  });
});

describe('gitResult', () => {
  it('returns the exit code of a command that exits with a code it accepts', async () => {
    const result = await gitResult(sandbox, ['config', '--get', 'absent.key'], 'read', {
      accepted: [0, 1],
    });

    expect(result.exitCode).toBe(1);
  });

  it('names the step of a command that exits with a code it does not accept', async () => {
    await expect(
      gitResult(sandbox, ['cat-file', '-e', 'absent'], 'find the root', { accepted: [0, 1] })
    ).rejects.toThrow(/^records: find the root failed: /u);
  });
});

describe('overlayGit', () => {
  beforeEach(async () => {
    await git(sandbox, ['init', '--bare', '--quiet', overlayDirectory(sandbox)]);
  });

  it('uses the root as its work tree', async () => {
    await expect(overlayGit(sandbox, ['rev-parse', '--show-toplevel'])).resolves.toBe(
      realpathSync(sandbox)
    );
  });

  it('reads the overlay index whatever index the calling environment names', async () => {
    vi.stubEnv('GIT_INDEX_FILE', path.join(sandbox, 'elsewhere-index'));
    await expect(overlayGit(sandbox, ['rev-parse', '--git-path', 'index'])).resolves.toBe(
      path.join(overlayDirectory(sandbox), 'index')
    );
  });
});
