import { afterAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { secondsAt, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  batchWorktreeFiles,
  listWorktreePaths,
  parseWorktreeListing,
  readWorktreeBlobs,
  WORKTREE_BATCH_BYTE_BUDGET,
} from './worktree.js';
import type { TextBlobEntry } from './rules.js';

/** A space and a tab, the two separators git quotes in every listing but `-z`. */
const SPACED_PATH = 'a note\twith spaces.md';
const NEWLINE_PATH = 'a note\nwith a newline.md';
/**
 * An absolute host path, assembled at runtime: written as a literal it would be
 * a disclosure in this file, which the gate this module feeds would then find.
 */
const HOST_PATH_TARGET = ['', 'home', 'someone', 'notes.md'].join('/');

interface Harness {
  readonly directory: string;
  git: (...args: string[]) => Promise<string>;
  write: (file: string, content: string) => Promise<void>;
  commit: (message: string) => Promise<string>;
}

const workspaces: string[] = [];

afterAll(async () => {
  await Promise.all(workspaces.map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function harness(): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-worktree-'));
  workspaces.push(directory);
  const git = async (...args: string[]): Promise<string> => {
    const result = await execa('git', ['-C', directory, ...args]);
    return result.stdout.trim();
  };
  const write = async (file: string, content: string): Promise<void> => {
    const absolute = path.join(directory, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  };
  const commit = async (message: string): Promise<string> => {
    const stamp = `@${String(secondsAt(TEST_DAY_START))} +0000`;
    await execa('git', ['-C', directory, 'commit', '-qm', message], {
      env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    });
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'agent@hushbox.ai');
  await git('config', 'user.name', 'agent');
  return { directory, git, write, commit };
}

function textOf(blobs: readonly TextBlobEntry[], blobPath: string): string {
  const found = blobs.find((blob) => blob.path === blobPath);
  return Buffer.from(found?.bytes ?? new Uint8Array()).toString('utf8');
}

describe('parseWorktreeListing', () => {
  it('keeps every byte of a path carrying a space and a tab', () => {
    expect(parseWorktreeListing(`${SPACED_PATH}\0plain.md\0`)).toEqual([SPACED_PATH, 'plain.md']);
  });

  it('answers no paths for an empty listing', () => {
    expect(parseWorktreeListing('')).toEqual([]);
  });

  it('refuses a path carrying a newline, naming it with the newline escaped', () => {
    expect(() => parseWorktreeListing(`${NEWLINE_PATH}\0`)).toThrow(
      String.raw`a note\nwith a newline.md`
    );
  });
});

describe('listWorktreePaths', () => {
  it('omits gitignored files while keeping untracked ones', async () => {
    const repo = await harness();
    await repo.write('.gitignore', 'ignored.md\n');
    await repo.write('tracked.md', 'a day, no clock\n');
    await repo.git('add', '.gitignore', 'tracked.md');
    await repo.commit('tracked');
    await repo.write('ignored.md', 'ignored\n');
    await repo.write('untracked.md', 'untracked\n');

    const paths = await listWorktreePaths(repo.directory);

    expect(paths.toSorted((left, right) => left.localeCompare(right))).toEqual([
      '.gitignore',
      'tracked.md',
      'untracked.md',
    ]);
  });

  // A tab and a newline are control characters, which Windows forbids in a
  // filename; the module under test is path-constructed and platform agnostic,
  // only the fixture is not.
  it.runIf(process.platform !== 'win32')(
    'keeps every byte of a worktree path carrying a space and a tab',
    async () => {
      const repo = await harness();
      await repo.write(SPACED_PATH, 'a day, no clock\n');

      expect(await listWorktreePaths(repo.directory)).toEqual([SPACED_PATH]);
    }
  );

  it.runIf(process.platform !== 'win32')('refuses a worktree path carrying a newline', async () => {
    const repo = await harness();
    await repo.write(NEWLINE_PATH, 'a day, no clock\n');

    await expect(listWorktreePaths(repo.directory)).rejects.toThrow(
      String.raw`a note\nwith a newline.md`
    );
  });
});

describe('readWorktreeBlobs', () => {
  it('reads the bytes on disk rather than the bytes git holds', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'committed\n');
    await repo.git('add', 'notes.md');
    await repo.commit('notes');
    await repo.write('notes.md', 'unstaged\n');

    expect(textOf(await readWorktreeBlobs(repo.directory, ['notes.md']), 'notes.md')).toBe(
      'unstaged\n'
    );
  });

  it('skips a tracked file the worktree no longer holds', async () => {
    const repo = await harness();
    await repo.write('gone.md', 'a day, no clock\n');
    await repo.write('kept.md', 'a day, no clock\n');
    await repo.git('add', 'gone.md', 'kept.md');
    await repo.commit('two files');
    await fs.rm(path.join(repo.directory, 'gone.md'));

    const blobs = await readWorktreeBlobs(repo.directory, await listWorktreePaths(repo.directory));

    expect(blobs.map((blob) => blob.path)).toEqual(['kept.md']);
  });

  it('skips a gitlink, which the worktree holds as a directory', async () => {
    const repo = await harness();
    await repo.write('kept.md', 'a day, no clock\n');
    await repo.git('add', 'kept.md');
    const commit = await repo.commit('kept');
    await fs.mkdir(path.join(repo.directory, 'module'));
    await repo.git('update-index', '--add', '--cacheinfo', `160000,${commit},module`);

    const blobs = await readWorktreeBlobs(repo.directory, await listWorktreePaths(repo.directory));

    expect(blobs.map((blob) => blob.path)).toEqual(['kept.md']);
  });

  // Creating a symlink on Windows is privilege-gated; the reader's own symlink
  // branch is platform agnostic, only the fixture is not.
  it.runIf(process.platform !== 'win32')(
    'reads a symlink as its target string rather than the bytes it points at',
    async () => {
      const repo = await harness();
      await repo.write('decoy.md', 'the bytes behind the link\n');
      await fs.symlink('decoy.md', path.join(repo.directory, 'link.md'));

      const text = textOf(await readWorktreeBlobs(repo.directory, ['link.md']), 'link.md');

      expect(text).toBe('decoy.md');
      expect(text).not.toBe('the bytes behind the link\n');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'reads a symlink whose target names an absolute host path',
    async () => {
      const repo = await harness();
      await fs.symlink(HOST_PATH_TARGET, path.join(repo.directory, 'host-link.md'));

      const blobs = await readWorktreeBlobs(
        repo.directory,
        await listWorktreePaths(repo.directory)
      );

      expect(textOf(blobs, 'host-link.md')).toBe(HOST_PATH_TARGET);
    }
  );

  it('answers no blobs when asked for no paths', async () => {
    const repo = await harness();

    expect(await readWorktreeBlobs(repo.directory, [])).toEqual([]);
  });
});

describe('batchWorktreeFiles', () => {
  it('starts a new batch once the declared byte budget is reached', () => {
    const half = Math.ceil(WORKTREE_BATCH_BYTE_BUDGET / 2);
    const files = [
      { path: 'a.md', size: half, link: false },
      { path: 'b.md', size: half, link: false },
      { path: 'c.md', size: half, link: false },
    ];

    expect(batchWorktreeFiles(files).map((batch) => batch.map((file) => file.path))).toEqual([
      ['a.md', 'b.md'],
      ['c.md'],
    ]);
  });
});
