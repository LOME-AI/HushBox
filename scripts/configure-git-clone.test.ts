import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { TEST_DAY_START, SECOND_MS } from '@hushbox/shared/test-time';
import {
  parseRepositories,
  readRepositories,
  stagingPushUrl,
  configureGitClone,
  checkPushDestination,
  describeOutcome,
  type Repositories,
} from './configure-git-clone.js';

/**
 * Fictional slugs, deliberately not the ones the runbook fixes: a suite written
 * against the real names cannot tell a config-driven match from a hardcoded
 * one. The shipped file's own names are pinned in their own test.
 */
const REPOSITORIES: Repositories = {
  publicRepo: 'Example-Org/Example',
  stagingRepo: 'Example-Org/Example-staging',
  recordsRepo: 'Example-Org/Example-records',
};

/** Both stamps of every fixture commit, so no fixture reads the running clock. */
const FIXTURE_DATE = `@${String(TEST_DAY_START / SECOND_MS)} +0000`;

let sandbox: string;
let cloneSequence = 0;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'configure-git-clone-'));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** Git accepts forward slashes on every platform; a Windows path does not survive a URL. */
function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa('git', [...args], {
    cwd,
    env: { GIT_AUTHOR_DATE: FIXTURE_DATE, GIT_COMMITTER_DATE: FIXTURE_DATE },
  });
  return stdout;
}

async function initWorkRepository(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Test Person']);
  await git(directory, ['config', 'user.email', 'test@example.invalid']);
}

/**
 * A bare repository at a path whose last two segments are the slug, so the
 * production URL rules see a real remote of the right name. It is seeded with a
 * commit because `ls-remote --exit-code` reports an empty repository as a
 * failure, and the staging repository this stands in for carries the codebase.
 */
async function createRemote(slug: string): Promise<string> {
  const bare = path.join(sandbox, 'remotes', `${slug}.git`);
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await execa('git', ['init', '--bare', '-q', '-b', 'main', bare]);

  const seed = path.join(sandbox, 'seed');
  await initWorkRepository(seed);
  await fs.writeFile(path.join(seed, 'a.txt'), 'a\n');
  await git(seed, ['add', 'a.txt']);
  await git(seed, ['commit', '-q', '-m', 'seed']);
  await git(seed, ['push', '-q', toPosixPath(bare), 'main']);
  await fs.rm(seed, { recursive: true, force: true });

  return toPosixPath(bare);
}

/** The URL a remote would carry without the remote existing. */
function absentRemoteUrl(slug: string): string {
  return toPosixPath(path.join(sandbox, 'remotes', `${slug}.git`));
}

async function createClone(originUrl: string | null): Promise<string> {
  cloneSequence += 1;
  const directory = path.join(sandbox, `clone-${String(cloneSequence)}`);
  await initWorkRepository(directory);
  if (originUrl !== null) await git(directory, ['remote', 'add', 'origin', originUrl]);
  return directory;
}

async function configuredValue(directory: string, key: string): Promise<string> {
  const { stdout } = await execa('git', ['config', '--local', '--default', '', '--get', key], {
    cwd: directory,
  });
  return stdout.trim();
}

/** What `git remote -v` reports, one entry per direction. */
async function remoteDirections(directory: string): Promise<Record<string, string>> {
  const listing = await git(directory, ['remote', '-v']);
  return Object.fromEntries(
    listing.split('\n').map((line) => {
      const [, url = '', direction = ''] = line.split(/\s+/);
      return [direction, url];
    })
  );
}

describe('parseRepositories', () => {
  it('reads the public, staging and records repositories', () => {
    const source = JSON.stringify(REPOSITORIES);

    expect(parseRepositories(source)).toEqual(REPOSITORIES);
  });

  it('rejects a file that names no records repository', () => {
    const source = JSON.stringify({
      publicRepo: REPOSITORIES.publicRepo,
      stagingRepo: REPOSITORIES.stagingRepo,
    });

    expect(() => parseRepositories(source)).toThrow(/recordsRepo/);
  });

  it('rejects a file that names no staging repository', () => {
    const source = JSON.stringify({ publicRepo: REPOSITORIES.publicRepo });

    expect(() => parseRepositories(source)).toThrow(/stagingRepo/);
  });

  it('rejects a key it does not know', () => {
    const source = JSON.stringify({ ...REPOSITORIES, publicRepoUrl: 'https://example.invalid' });

    expect(() => parseRepositories(source)).toThrow(/publicRepoUrl/);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseRepositories('{')).toThrow(/valid JSON/);
  });
});

describe('the shipped repositories file', () => {
  it('names the repositories the setup runbook fixes and the records repository', async () => {
    await expect(readRepositories()).resolves.toEqual({
      publicRepo: 'LOME-AI/HushBox',
      stagingRepo: 'LOME-AI/HushBox-staging',
      recordsRepo: 'LOME-AI/HushBox-records',
    });
  });
});

describe('stagingPushUrl', () => {
  it('keeps the transport and suffix of an https origin', () => {
    expect(stagingPushUrl('https://github.com/Example-Org/Example.git', REPOSITORIES)).toBe(
      'https://github.com/Example-Org/Example-staging.git'
    );
  });

  it('keeps the transport of an ssh origin', () => {
    expect(stagingPushUrl('git@github.com:Example-Org/Example.git', REPOSITORIES)).toBe(
      'git@github.com:Example-Org/Example-staging.git'
    );
  });

  it('recognizes the canonical repository whatever case it is written in', () => {
    expect(stagingPushUrl('https://github.com/example-org/example', REPOSITORIES)).toBe(
      'https://github.com/Example-Org/Example-staging'
    );
  });

  it('recognizes the canonical repository through a trailing slash', () => {
    expect(stagingPushUrl('https://github.com/Example-Org/Example/', REPOSITORIES)).toBe(
      'https://github.com/Example-Org/Example-staging/'
    );
  });

  it('declines an origin that is another owner’s repository', () => {
    expect(stagingPushUrl('https://github.com/Someone-Else/Example.git', REPOSITORIES)).toBeNull();
  });

  it('declines an origin carrying no owner segment', () => {
    expect(stagingPushUrl('Example', REPOSITORIES)).toBeNull();
  });

  it('declines an origin whose owner and name are not adjacent', () => {
    expect(stagingPushUrl('Example-Org:Example', REPOSITORIES)).toBeNull();
  });
});

describe('configureGitClone', () => {
  it('sets the local identity guard', async () => {
    const clone = await createClone(await createRemote(REPOSITORIES.publicRepo));

    await configureGitClone(clone, REPOSITORIES);

    await expect(configuredValue(clone, 'user.useConfigOnly')).resolves.toBe('true');
  });

  it('routes pushes to staging while fetch stays on the public repository', async () => {
    const publicUrl = await createRemote(REPOSITORIES.publicRepo);
    const stagingUrl = await createRemote(REPOSITORIES.stagingRepo);
    const clone = await createClone(publicUrl);

    const outcome = await configureGitClone(clone, REPOSITORIES);

    expect(outcome).toEqual({ status: 'configured', routing: { status: 'routed' } });
    await expect(remoteDirections(clone)).resolves.toEqual({
      '(fetch)': publicUrl,
      '(push)': stagingUrl,
    });
  });

  it('leaves the push URL alone when staging cannot be reached', async () => {
    const clone = await createClone(await createRemote(REPOSITORIES.publicRepo));

    const outcome = await configureGitClone(clone, REPOSITORIES);

    expect(outcome).toEqual({ status: 'configured', routing: { status: 'staging-unreachable' } });
    await expect(configuredValue(clone, 'remote.origin.pushurl')).resolves.toBe('');
  });

  it('routes a clone whose maintainer could not reach staging on an earlier run', async () => {
    const clone = await createClone(await createRemote(REPOSITORIES.publicRepo));
    await configureGitClone(clone, REPOSITORIES);

    const stagingUrl = await createRemote(REPOSITORIES.stagingRepo);
    const outcome = await configureGitClone(clone, REPOSITORIES);

    expect(outcome).toEqual({ status: 'configured', routing: { status: 'routed' } });
    await expect(configuredValue(clone, 'remote.origin.pushurl')).resolves.toBe(stagingUrl);
  });

  it('leaves a fork untouched', async () => {
    await createRemote(REPOSITORIES.stagingRepo);
    const clone = await createClone(await createRemote('Someone-Else/Example'));

    const outcome = await configureGitClone(clone, REPOSITORIES);

    expect(outcome).toEqual({ status: 'configured', routing: { status: 'origin-not-canonical' } });
    await expect(configuredValue(clone, 'remote.origin.pushurl')).resolves.toBe('');
  });

  it('keeps the routing it already applied without probing again', async () => {
    const clone = await createClone(await createRemote(REPOSITORIES.publicRepo));
    const stagingUrl = await createRemote(REPOSITORIES.stagingRepo);
    await configureGitClone(clone, REPOSITORIES);
    await fs.rm(path.join(sandbox, 'remotes', `${REPOSITORIES.stagingRepo}.git`), {
      recursive: true,
      force: true,
    });

    const outcome = await configureGitClone(clone, REPOSITORIES);

    expect(outcome).toEqual({ status: 'configured', routing: { status: 'already-routed' } });
    await expect(configuredValue(clone, 'remote.origin.pushurl')).resolves.toBe(stagingUrl);
  });

  it('keeps a push URL the developer set by hand', async () => {
    await createRemote(REPOSITORIES.stagingRepo);
    const clone = await createClone(await createRemote(REPOSITORIES.publicRepo));
    const chosen = absentRemoteUrl('Example-Org/Example-mirror');
    await git(clone, ['remote', 'set-url', '--push', 'origin', chosen]);

    const outcome = await configureGitClone(clone, REPOSITORIES);

    expect(outcome).toEqual({ status: 'configured', routing: { status: 'manual-push-url' } });
    await expect(configuredValue(clone, 'remote.origin.pushurl')).resolves.toBe(chosen);
  });

  it('routes nothing in a clone that has no origin', async () => {
    const clone = await createClone(null);

    const outcome = await configureGitClone(clone, REPOSITORIES);

    expect(outcome).toEqual({ status: 'configured', routing: { status: 'no-origin' } });
  });

  it('does nothing in a directory that is not a repository', async () => {
    const plain = path.join(sandbox, 'plain');
    await fs.mkdir(plain, { recursive: true });

    await expect(configureGitClone(plain, REPOSITORIES)).resolves.toEqual({
      status: 'no-repository',
    });
  });

  it('does nothing when git cannot run at all', async () => {
    await expect(configureGitClone(path.join(sandbox, 'gone'), REPOSITORIES)).resolves.toEqual({
      status: 'no-repository',
    });
  });
});

describe('checkPushDestination', () => {
  it('refuses a push aimed at the public repository from a routed clone', async () => {
    const publicUrl = await createRemote(REPOSITORIES.publicRepo);
    await createRemote(REPOSITORIES.stagingRepo);
    const clone = await createClone(publicUrl);
    await configureGitClone(clone, REPOSITORIES);

    await expect(checkPushDestination(clone, publicUrl, REPOSITORIES)).resolves.toContain(
      REPOSITORIES.publicRepo
    );
  });

  it('allows a push aimed at staging from a routed clone', async () => {
    const publicUrl = await createRemote(REPOSITORIES.publicRepo);
    const stagingUrl = await createRemote(REPOSITORIES.stagingRepo);
    const clone = await createClone(publicUrl);
    await configureGitClone(clone, REPOSITORIES);

    await expect(checkPushDestination(clone, stagingUrl, REPOSITORIES)).resolves.toBeNull();
  });

  it('allows a push to the public repository from a clone pushing somewhere else', async () => {
    const publicUrl = await createRemote(REPOSITORIES.publicRepo);
    const clone = await createClone(publicUrl);
    await git(clone, [
      'remote',
      'set-url',
      '--push',
      'origin',
      absentRemoteUrl('Example-Org/Example-mirror'),
    ]);

    await expect(checkPushDestination(clone, publicUrl, REPOSITORIES)).resolves.toBeNull();
  });

  it('allows a push to the public repository from a clone that was never routed', async () => {
    const publicUrl = await createRemote(REPOSITORIES.publicRepo);
    const clone = await createClone(publicUrl);

    await expect(checkPushDestination(clone, publicUrl, REPOSITORIES)).resolves.toBeNull();
  });
});

describe('describeOutcome', () => {
  it('announces the routing it applied', () => {
    expect(describeOutcome({ status: 'configured', routing: { status: 'routed' } })).toContain(
      'push'
    );
  });

  it('announces that it kept a push URL it found', () => {
    expect(
      describeOutcome({ status: 'configured', routing: { status: 'manual-push-url' } })
    ).toContain('push');
  });

  it('says nothing about a directory it did not configure', () => {
    expect(describeOutcome({ status: 'no-repository' })).toBeNull();
  });

  it('says nothing about a clone it left alone', () => {
    expect(
      describeOutcome({ status: 'configured', routing: { status: 'staging-unreachable' } })
    ).toBeNull();
  });
});
