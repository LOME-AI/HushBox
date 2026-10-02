import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { resolveAssociatedPrLabels } from '@hushbox/ops/associated-pull-requests';
import {
  parseSemver,
  compareSemver,
  determineBumpType,
  computeNextVersion,
  findLatestStableTag,
  pushClaim,
  claimNextVersion,
  main,
  type GitRunner,
} from './compute-next-version.js';
import { git as publicationGit } from '../lib/publication/git.js';
import { claimRef } from '../lib/release-references.js';

describe('parseSemver', () => {
  it('parses a basic semver string', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('strips v prefix', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('parses 0.0.0', () => {
    expect(parseSemver('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('parses large version numbers', () => {
    expect(parseSemver('10.20.30')).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it('throws on invalid input', () => {
    expect(() => parseSemver('not-a-version')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => parseSemver('')).toThrow();
  });

  it('throws on incomplete semver', () => {
    expect(() => parseSemver('1.2')).toThrow();
  });

  it('throws on pre-release suffix', () => {
    expect(() => parseSemver('1.2.3-beta.1')).toThrow();
  });
});

describe('compareSemver', () => {
  it('orders a lower version first', () => {
    expect(compareSemver('v1.2.3', 'v1.2.4')).toBeLessThan(0);
  });

  it('orders a higher version last', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('reads the same version with and without its prefix as equal', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });

  it('compares each component as a number, so the tenth minor follows the ninth', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });
});

describe('determineBumpType', () => {
  it('returns major when major label present', () => {
    expect(determineBumpType(['major'])).toBe('major');
  });

  it('returns minor when minor label present', () => {
    expect(determineBumpType(['minor'])).toBe('minor');
  });

  it('returns patch when patch label present', () => {
    expect(determineBumpType(['patch'])).toBe('patch');
  });

  it('defaults to patch when no recognized label', () => {
    expect(determineBumpType(['bugfix', 'documentation'])).toBe('patch');
  });

  it('defaults to patch when labels array is empty', () => {
    expect(determineBumpType([])).toBe('patch');
  });

  it('major takes priority over minor and patch', () => {
    expect(determineBumpType(['patch', 'minor', 'major'])).toBe('major');
  });

  it('minor takes priority over patch', () => {
    expect(determineBumpType(['patch', 'minor'])).toBe('minor');
  });
});

describe('computeNextVersion', () => {
  it('returns 1.0.0 when no prior tags', () => {
    const result = computeNextVersion({ latestTag: null, labels: [] });

    expect(result.version).toBe('1.0.0');
    expect(result.versionName).toBe('1.0.0');
    expect(result.versionCode).toBe(1_000_000);
  });

  it('increments patch by default', () => {
    const result = computeNextVersion({ latestTag: 'v1.0.0', labels: [] });

    expect(result.version).toBe('1.0.1');
    expect(result.versionCode).toBe(1_000_001);
  });

  it('increments minor and resets patch', () => {
    const result = computeNextVersion({ latestTag: 'v1.2.3', labels: ['minor'] });

    expect(result.version).toBe('1.3.0');
    expect(result.versionCode).toBe(1_003_000);
  });

  it('increments major and resets minor and patch', () => {
    const result = computeNextVersion({ latestTag: 'v1.2.3', labels: ['major'] });

    expect(result.version).toBe('2.0.0');
    expect(result.versionCode).toBe(2_000_000);
  });

  it('increments patch with explicit patch label', () => {
    const result = computeNextVersion({ latestTag: 'v1.2.3', labels: ['patch'] });

    expect(result.version).toBe('1.2.4');
    expect(result.versionCode).toBe(1_002_004);
  });

  it('returns 1.0.0 when no prior tags even with major label', () => {
    const result = computeNextVersion({ latestTag: null, labels: ['major'] });

    expect(result.version).toBe('1.0.0');
  });

  it('version and versionName are always equal', () => {
    const result = computeNextVersion({ latestTag: 'v3.5.9', labels: ['patch'] });

    expect(result.version).toBe(result.versionName);
  });
});

let sandbox: string;
let fixtureCount = 0;

async function run(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa('git', [...args], { cwd: directory });
  return stdout.trim();
}

/** A bare remote and one working clone of it, carrying one commit on `main`. */
async function initRemote(): Promise<{ remote: string; clone: string }> {
  fixtureCount += 1;
  const remote = path.join(sandbox, `remote-${String(fixtureCount)}.git`);
  await run(sandbox, ['init', '-q', '--bare', '-b', 'main', remote]);
  const clone = await cloneOf(remote);
  await commit(clone, 'first');
  await run(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  return { remote, clone };
}

async function cloneOf(remote: string): Promise<string> {
  fixtureCount += 1;
  const clone = path.join(sandbox, `clone-${String(fixtureCount)}`);
  await run(sandbox, ['clone', '-q', remote, clone]);
  await run(clone, ['config', 'user.name', 'Test Person']);
  await run(clone, ['config', 'user.email', 'test@example.invalid']);
  return clone;
}

/** Commits a change and answers the new commit. */
async function commit(clone: string, message: string): Promise<string> {
  await fs.writeFile(path.join(clone, 'change.txt'), message);
  await run(clone, ['add', '.']);
  await run(clone, ['commit', '-q', '-m', message]);
  return run(clone, ['rev-parse', 'HEAD']);
}

/** Every claim ref the remote carries, with the commit each names. */
async function remoteClaims(remote: string): Promise<Record<string, string>> {
  const listed = await run(remote, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/version-claims',
  ]);
  return Object.fromEntries(
    listed
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [ref = '', id = ''] = line.split(' ');
        return [ref, id];
      })
  );
}

async function claimOnRemote(clone: string, commitId: string, version: string): Promise<void> {
  await run(clone, ['push', '-q', 'origin', `${commitId}:${claimRef(version)}`]);
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'compute-next-version-'));
  const globalConfig = path.join(sandbox, 'gitconfig');
  await fs.writeFile(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('findLatestStableTag', () => {
  it('answers the highest release tag', async () => {
    const { clone } = await initRemote();
    await run(clone, ['tag', 'v2.0.0']);
    await commit(clone, 'second');
    await run(clone, ['tag', 'v2.1.0']);

    expect(await findLatestStableTag(clone)).toBe('v2.1.0');
  });

  it('orders by version, so the tenth minor outranks the ninth', async () => {
    const { clone } = await initRemote();
    await run(clone, ['tag', 'v1.10.0']);
    await run(clone, ['tag', 'v1.9.0']);

    expect(await findLatestStableTag(clone)).toBe('v1.10.0');
  });

  it('passes over a pre-release tag', async () => {
    const { clone } = await initRemote();
    await run(clone, ['tag', 'v1.5.0']);
    await run(clone, ['tag', 'v2.0.0-beta.1']);

    expect(await findLatestStableTag(clone)).toBe('v1.5.0');
  });

  it('answers null when no release tag exists', async () => {
    const { clone } = await initRemote();
    await run(clone, ['tag', 'v2.0.0-beta.1']);

    expect(await findLatestStableTag(clone)).toBeNull();
  });

  it('passes over a claim, which reserves a number but ships nothing', async () => {
    const { clone } = await initRemote();
    await run(clone, ['tag', 'v1.0.0']);
    await run(clone, ['update-ref', claimRef('1.4.0'), 'HEAD']);

    expect(await findLatestStableTag(clone)).toBe('v1.0.0');
  });
});

describe('pushClaim', () => {
  it('refuses to move an existing claim onto a descendant commit', async () => {
    const { remote, clone } = await initRemote();
    const first = await run(clone, ['rev-parse', 'HEAD']);
    await claimOnRemote(clone, first, '1.2.3');
    const descendant = await commit(clone, 'second');

    await expect(
      pushClaim({ repositoryRoot: clone, sha: descendant, version: '1.2.3' })
    ).rejects.toThrow();
    expect(await remoteClaims(remote)).toEqual({ [claimRef('1.2.3')]: first });
  });

  it('creates a claim the remote does not carry yet', async () => {
    const { remote, clone } = await initRemote();
    const head = await run(clone, ['rev-parse', 'HEAD']);

    await pushClaim({ repositoryRoot: clone, sha: head, version: '1.0.0' });

    expect(await remoteClaims(remote)).toEqual({ [claimRef('1.0.0')]: head });
  });
});

describe('claimNextVersion', () => {
  it('claims 1.0.0 at the commit when nothing was ever tagged or claimed', async () => {
    const { remote, clone } = await initRemote();
    const head = await run(clone, ['rev-parse', 'HEAD']);

    const result = await claimNextVersion({ repositoryRoot: clone, sha: head, labels: [] });

    expect(result).toEqual({
      version: '1.0.0',
      versionName: '1.0.0',
      versionCode: 1_000_000,
      claimed: true,
    });
    expect(await remoteClaims(remote)).toEqual({ [claimRef('1.0.0')]: head });
  });

  it('bumps from the highest of the release tags and the claims', async () => {
    const { remote, clone } = await initRemote();
    const first = await run(clone, ['rev-parse', 'HEAD']);
    await run(clone, ['tag', 'v1.3.0']);
    await claimOnRemote(clone, first, '1.4.0');
    const head = await commit(clone, 'second');

    const result = await claimNextVersion({ repositoryRoot: clone, sha: head, labels: [] });

    expect(result.version).toBe('1.4.1');
    expect(await remoteClaims(remote)).toEqual({
      [claimRef('1.4.0')]: first,
      [claimRef('1.4.1')]: head,
    });
  });

  it('applies the bump the pull request labels ask for', async () => {
    const { clone } = await initRemote();
    await run(clone, ['tag', 'v1.3.2']);
    const head = await commit(clone, 'second');

    const result = await claimNextVersion({ repositoryRoot: clone, sha: head, labels: ['minor'] });

    expect(result.version).toBe('1.4.0');
  });

  it('declines to claim when a claim already names a descendant commit', async () => {
    const { remote, clone } = await initRemote();
    const older = await run(clone, ['rev-parse', 'HEAD']);
    const newer = await commit(clone, 'second');
    await claimOnRemote(clone, newer, '1.0.0');

    const result = await claimNextVersion({ repositoryRoot: clone, sha: older, labels: [] });

    expect(result).toEqual({
      version: '1.0.1',
      versionName: '1.0.1',
      versionCode: 1_000_001,
      claimed: false,
    });
    expect(await remoteClaims(remote)).toEqual({ [claimRef('1.0.0')]: newer });
  });

  it('declines to claim when a release tag already names a descendant commit', async () => {
    const { remote, clone } = await initRemote();
    const older = await run(clone, ['rev-parse', 'HEAD']);
    await commit(clone, 'second');
    await run(clone, ['tag', 'v1.0.0']);

    const result = await claimNextVersion({ repositoryRoot: clone, sha: older, labels: [] });

    expect(result.claimed).toBe(false);
    expect(await remoteClaims(remote)).toEqual({});
  });

  it('claims a fresh number when a claim already names this very commit', async () => {
    const { remote, clone } = await initRemote();
    const head = await run(clone, ['rev-parse', 'HEAD']);
    await claimOnRemote(clone, head, '1.0.0');

    const result = await claimNextVersion({ repositoryRoot: clone, sha: head, labels: [] });

    expect(result).toMatchObject({ version: '1.0.1', claimed: true });
    expect(await remoteClaims(remote)).toEqual({
      [claimRef('1.0.0')]: head,
      [claimRef('1.0.1')]: head,
    });
  });

  it('reads an annotated release tag on this very commit as taken rather than as newer', async () => {
    const { clone } = await initRemote();
    const head = await run(clone, ['rev-parse', 'HEAD']);
    await run(clone, ['tag', '-a', '-m', 'release', 'v1.0.0']);

    const result = await claimNextVersion({ repositoryRoot: clone, sha: head, labels: [] });

    expect(result).toMatchObject({ version: '1.0.1', claimed: true });
  });

  it('reads the claims the remote carries now rather than the ones the checkout saw', async () => {
    const { remote, clone } = await initRemote();
    const other = await cloneOf(remote);
    const first = await run(other, ['rev-parse', 'HEAD']);
    await claimOnRemote(other, first, '1.5.0');
    const head = await commit(clone, 'second');

    const result = await claimNextVersion({ repositoryRoot: clone, sha: head, labels: [] });

    expect(result.version).toBe('1.5.1');
  });

  it('fails when another run claims the same number between the read and the push', async () => {
    const { remote, clone } = await initRemote();
    const other = await cloneOf(remote);
    const rival = await run(other, ['rev-parse', 'HEAD']);
    const head = await commit(clone, 'second');
    // A second run claiming the number this one is about to claim, landing after
    // this run fetched the claims and before it pushed.
    const racing: GitRunner = async (cwd, args) => {
      if (args[0] === 'push') await claimOnRemote(other, rival, '1.0.0');
      return publicationGit(cwd, args);
    };

    await expect(
      claimNextVersion({ repositoryRoot: clone, sha: head, labels: [], git: racing })
    ).rejects.toThrow('git push failed');
    expect(await remoteClaims(remote)).toEqual({ [claimRef('1.0.0')]: rival });
  });
});

describe('main', () => {
  const mockFetch = vi.fn();

  const labelled = (labels: readonly string[]): void => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ labels: labels.map((name) => ({ name })) }]),
    });
  };

  let logSpy: MockInstance;

  const outputLines = (): string[] => logSpy.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('GITHUB_TOKEN', 'token');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
    vi.stubEnv('GITHUB_OUTPUT', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('throws when GITHUB_TOKEN is missing', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITHUB_SHA', 'abc123');

    await expect(main({ repositoryRoot: sandbox })).rejects.toThrow('GITHUB_TOKEN is required');
  });

  it('throws when GITHUB_REPOSITORY is missing', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');
    vi.stubEnv('GITHUB_SHA', 'abc123');

    await expect(main({ repositoryRoot: sandbox })).rejects.toThrow(
      'GITHUB_REPOSITORY is required'
    );
  });

  it('throws when GITHUB_SHA is missing', async () => {
    vi.stubEnv('GITHUB_SHA', '');

    await expect(main({ repositoryRoot: sandbox })).rejects.toThrow('GITHUB_SHA is required');
  });

  it('refuses a claim flag it cannot read rather than computing without claiming', async () => {
    vi.stubEnv('GITHUB_SHA', 'abc123');
    vi.stubEnv('CLAIM_VERSION', 'yes');

    await expect(main({ repositoryRoot: sandbox })).rejects.toThrow('CLAIM_VERSION');
  });

  it('writes the computed next version to the workflow output', async () => {
    const { clone } = await initRemote();
    await run(clone, ['tag', 'v1.2.3']);
    vi.stubEnv('GITHUB_SHA', await run(clone, ['rev-parse', 'HEAD']));
    labelled(['minor']);

    await main({ repositoryRoot: clone });

    expect(outputLines()).toEqual([
      'version=1.3.0',
      'version_name=1.3.0',
      'version_code=1003000',
      'claimed=false',
    ]);
  });

  it('claims nothing without the claim flag', async () => {
    const { remote, clone } = await initRemote();
    vi.stubEnv('GITHUB_SHA', await run(clone, ['rev-parse', 'HEAD']));
    labelled([]);

    await main({ repositoryRoot: clone });

    expect(await remoteClaims(remote)).toEqual({});
  });

  it('claims the next version and says so when the claim flag is set', async () => {
    const { remote, clone } = await initRemote();
    await run(clone, ['tag', 'v1.2.3']);
    const head = await commit(clone, 'second');
    vi.stubEnv('GITHUB_SHA', head);
    vi.stubEnv('CLAIM_VERSION', 'true');
    labelled([]);

    await main({ repositoryRoot: clone });

    expect(outputLines()).toEqual([
      'version=1.2.4',
      'version_name=1.2.4',
      'version_code=1002004',
      'claimed=true',
    ]);
    expect(await remoteClaims(remote)).toEqual({ [claimRef('1.2.4')]: head });
  });

  it('refuses to bump when the commit maps to multiple pull requests', async () => {
    const { clone } = await initRemote();
    vi.stubEnv('GITHUB_SHA', await run(clone, ['rev-parse', 'HEAD']));
    const prs = [
      { number: 42, labels: [{ name: 'major' }] },
      { number: 99, labels: [{ name: 'minor' }] },
    ];
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(prs) });

    const ambiguity = resolveAssociatedPrLabels(prs);
    expect(ambiguity.ok).toBe(false);
    if (ambiguity.ok) return;

    await expect(main({ repositoryRoot: clone })).rejects.toThrow(ambiguity.error);
  });
});
