import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { TEST_DAY_START, SECOND_MS } from '@hushbox/shared/test-time';
import {
  SYNC_BOT_IDENTITY,
  branchHead,
  fastForwardRemoteBranch,
  fetchRemoteBranch,
  firstParentCommits,
  git,
  isAncestor,
  pushBranch,
  redactCredentials,
} from './git.js';

/** Both stamps on every fixture commit, so no fixture reads a running clock. */
const FIXTURE_DATE = `@${String(TEST_DAY_START / SECOND_MS)} +0000`;

const MAIN = 'main';

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'publication-git-'));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** Git accepts forward slashes on every platform; a Windows path does not survive a URL. */
function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa('git', [...args], {
    cwd,
    env: {
      GIT_AUTHOR_DATE: FIXTURE_DATE,
      GIT_COMMITTER_DATE: FIXTURE_DATE,
      GIT_AUTHOR_NAME: SYNC_BOT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: SYNC_BOT_IDENTITY.email,
      GIT_COMMITTER_NAME: SYNC_BOT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: SYNC_BOT_IDENTITY.email,
    },
  });
  return stdout.trim();
}

async function commit(cwd: string, marker: string): Promise<string> {
  await fs.writeFile(path.join(cwd, `${marker}.txt`), `${marker}\n`, 'utf8');
  await run(cwd, ['add', '-A']);
  await run(cwd, ['commit', '-m', marker]);
  return run(cwd, ['rev-parse', 'HEAD']);
}

async function initWorkRepository(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await run(directory, ['init', '--initial-branch', MAIN]);
  await run(directory, ['config', 'user.name', SYNC_BOT_IDENTITY.name]);
  await run(directory, ['config', 'user.email', SYNC_BOT_IDENTITY.email]);
}

/** A bare repository standing in for a remote, plus the work tree that seeded it. */
interface Remote {
  readonly url: string;
  readonly seed: string;
}

async function createRemote(name: string): Promise<Remote> {
  const bare = path.join(sandbox, `${name}.git`);
  await execa('git', ['init', '--bare', '--initial-branch', MAIN, bare]);

  const seed = path.join(sandbox, `${name}-seed`);
  await initWorkRepository(seed);
  await commit(seed, 'base');
  await run(seed, ['push', toPosixPath(bare), `${MAIN}:refs/heads/${MAIN}`]);

  return { url: toPosixPath(bare), seed };
}

async function remoteHead(url: string): Promise<string> {
  const { stdout } = await execa('git', ['ls-remote', url, `refs/heads/${MAIN}`]);
  return stdout.split(/\s/)[0] ?? '';
}

describe('redactCredentials', () => {
  it('masks the userinfo a token travels in', () => {
    expect(redactCredentials('https://x-access-token:secret-value@github.com/Owner/Name.git')).toBe(
      'https://***@github.com/Owner/Name.git'
    );
  });

  it('leaves a URL carrying no credential alone', () => {
    expect(redactCredentials('https://github.com/Owner/Name.git')).toBe(
      'https://github.com/Owner/Name.git'
    );
  });
});

describe('git', () => {
  it('answers what the command wrote', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const head = await commit(work, 'only');

    expect(await git(work, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('reports a failure without the credential the URL it was given carried', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const url = 'https://x-access-token:secret-value@127.0.0.1:1/Owner/Name.git';

    const failure = git(work, ['ls-remote', url]);

    // The message still names what failed — so the absence below is the
    // credential being kept out, not the message being empty.
    await expect(failure).rejects.toThrow(/ls-remote/);
    await expect(failure).rejects.not.toThrow(/secret-value/);
  });
});

describe('fetchRemoteBranch', () => {
  it('brings the branch head into the local repository and names it', async () => {
    const remote = await createRemote('origin');
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);

    const head = await fetchRemoteBranch(clone, remote.url, MAIN);

    expect(head).toBe(await remoteHead(remote.url));
    expect(await run(clone, ['cat-file', '-t', head])).toBe('commit');
  });

  it('fails loudly rather than answering for a branch the remote does not carry', async () => {
    const remote = await createRemote('origin');
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);

    await expect(fetchRemoteBranch(clone, remote.url, 'absent')).rejects.toThrow(/absent/);
  });
});

describe('isAncestor', () => {
  it('reads a parent as an ancestor of its child', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const first = await commit(work, 'first');
    const second = await commit(work, 'second');

    expect(await isAncestor(work, first, second)).toBe(true);
  });

  it('reads a child as no ancestor of its parent, so the answer is not constant', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const first = await commit(work, 'first');
    const second = await commit(work, 'second');

    expect(await isAncestor(work, second, first)).toBe(false);
  });

  it('refuses to answer for an object the repository does not have', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const only = await commit(work, 'only');

    await expect(isAncestor(work, 'f'.repeat(40), only)).rejects.toThrow(/exit code/);
  });

  it('reads two sides of a divergence as ancestors of neither', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const base = await commit(work, 'base');
    const left = await commit(work, 'left');
    await run(work, ['checkout', '-b', 'right', base]);
    const right = await commit(work, 'right');

    expect(await isAncestor(work, left, right)).toBe(false);
    expect(await isAncestor(work, right, left)).toBe(false);
  });
});

describe('branchHead', () => {
  it('answers where the branch stands rather than where the checkout sits', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const trunk = await commit(work, 'trunk');
    await run(work, ['checkout', '--quiet', '-b', 'side']);
    const side = await commit(work, 'side');

    expect(await branchHead(work, MAIN)).toBe(trunk);
    // The two really differ here, so the answer above is the branch being read
    // rather than the checkout happening to sit on it.
    expect(await run(work, ['rev-parse', 'HEAD'])).toBe(side);
  });

  it('fails loudly rather than answering for a branch the repository does not carry', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    await commit(work, 'only');

    await expect(branchHead(work, 'absent')).rejects.toThrow(/rev-parse/);
  });
});

describe('firstParentCommits', () => {
  it('answers a revision and its ancestors, newest first', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const first = await commit(work, 'first');
    const second = await commit(work, 'second');
    const third = await commit(work, 'third');

    expect(await firstParentCommits(work, 'HEAD', 10)).toEqual([third, second, first]);
  });

  it('stops at the limit it was given rather than walking the whole history', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    await commit(work, 'first');
    const second = await commit(work, 'second');
    const third = await commit(work, 'third');

    expect(await firstParentCommits(work, 'HEAD', 2)).toEqual([third, second]);
  });

  it('leaves the merged-in side of a merge out of the mainline', async () => {
    const work = path.join(sandbox, 'work');
    await initWorkRepository(work);
    const base = await commit(work, 'base');
    await run(work, ['checkout', '--quiet', '-b', 'side']);
    const side = await commit(work, 'side');
    await run(work, ['checkout', '--quiet', MAIN]);
    await run(work, ['merge', '--no-ff', '--no-edit', '-m', 'merge side', side]);
    const merge = await run(work, ['rev-parse', 'HEAD']);

    // The side commit is reachable, so a walk of everything would offer it as a
    // publishable candidate; the mainline is the set the trunk actually stood at.
    expect(await firstParentCommits(work, 'HEAD', 10)).toEqual([merge, base]);
  });
});

describe('pushBranch', () => {
  it('advances the remote branch when the push is a fast-forward', async () => {
    const remote = await createRemote('origin');
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);
    await fetchRemoteBranch(clone, remote.url, MAIN);
    await run(clone, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const advanced = await commit(clone, 'next');

    expect(await pushBranch(clone, remote.url, advanced, MAIN)).toBe('pushed');
    expect(await remoteHead(remote.url)).toBe(advanced);
  });

  it('reports the remote refusing a push that is not a fast-forward, leaving it where it stood', async () => {
    const remote = await createRemote('origin');
    const held = await remoteHead(remote.url);
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);
    const unrelated = await commit(clone, 'unrelated');

    expect(await pushBranch(clone, remote.url, unrelated, MAIN)).toBe('rejected');
    expect(await remoteHead(remote.url)).toBe(held);
  });
});

describe('fastForwardRemoteBranch', () => {
  it('advances a remote whose head the target descends from', async () => {
    const remote = await createRemote('origin');
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);
    await fetchRemoteBranch(clone, remote.url, MAIN);
    await run(clone, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const advanced = await commit(clone, 'next');

    expect(await fastForwardRemoteBranch(clone, remote.url, MAIN, advanced)).toEqual({
      status: 'advanced',
      head: advanced,
    });
    expect(await remoteHead(remote.url)).toBe(advanced);
  });

  it('reads a remote already carrying the target as current and pushes nothing', async () => {
    const remote = await createRemote('origin');
    const head = await remoteHead(remote.url);
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);

    expect(await fastForwardRemoteBranch(clone, remote.url, MAIN, head)).toEqual({
      status: 'already-current',
      head,
    });
  });

  it('refuses a diverged remote and leaves its head exactly where it stood', async () => {
    const remote = await createRemote('origin');
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);
    await fetchRemoteBranch(clone, remote.url, MAIN);
    await run(clone, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const target = await commit(clone, 'staging-only');

    // The remote moves on to a commit the target does not descend from: the
    // divergence an inbound sync that never landed would leave behind.
    const other = path.join(sandbox, 'other');
    await initWorkRepository(other);
    await fetchRemoteBranch(other, remote.url, MAIN);
    await run(other, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const diverged = await commit(other, 'public-only');
    await run(other, ['push', remote.url, `${MAIN}:refs/heads/${MAIN}`]);

    expect(await fastForwardRemoteBranch(clone, remote.url, MAIN, target)).toEqual({
      status: 'refused',
      head: diverged,
    });
    expect(await remoteHead(remote.url)).toBe(diverged);
  });

  it('refuses when the remote rejects a push its ancestry check had admitted', async () => {
    // A non-bare remote with the branch checked out refuses every push to it,
    // which is the only way to reach the rejection that sits behind a passing
    // ancestry check: the head moving between the two reads.
    const remote = path.join(sandbox, 'checked-out-remote');
    await initWorkRepository(remote);
    const head = await commit(remote, 'base');

    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);
    await fetchRemoteBranch(clone, toPosixPath(remote), MAIN);
    await run(clone, ['checkout', '-B', MAIN, 'FETCH_HEAD']);
    const advanced = await commit(clone, 'next');

    expect(await fastForwardRemoteBranch(clone, toPosixPath(remote), MAIN, advanced)).toEqual({
      status: 'refused',
      head,
    });
    expect(await run(remote, ['rev-parse', MAIN])).toBe(head);
  });

  it('leaves a remote a force push would have overwritten, so the refusal above is not vacuity', async () => {
    const remote = await createRemote('origin');
    const clone = path.join(sandbox, 'clone');
    await initWorkRepository(clone);
    const unrelated = await commit(clone, 'unrelated');

    expect(await fastForwardRemoteBranch(clone, remote.url, MAIN, unrelated)).toMatchObject({
      status: 'refused',
    });

    // The same push with the flag this module never passes does overwrite it,
    // which is what makes the refusal above a property of the code rather than
    // of a remote that could not have been moved anyway.
    await run(clone, ['push', '--force', remote.url, `${unrelated}:refs/heads/${MAIN}`]);
    expect(await remoteHead(remote.url)).toBe(unrelated);
  });
});
