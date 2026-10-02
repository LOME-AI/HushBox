import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { createServer } from 'node:net';
import {
  parsePushReferences,
  computePushedRange,
  resolvePushedRange,
  advertisedObjectIds,
  advertisementFailure,
} from './pushed-range.js';
import type { Server, Socket } from 'node:net';

const ZERO = '0'.repeat(40);

describe('parsePushReferences', () => {
  it('returns an empty array for empty stdin', () => {
    expect(parsePushReferences('')).toEqual([]);
  });

  it('ignores blank lines and surrounding whitespace', () => {
    expect(parsePushReferences('\n  \n')).toEqual([]);
  });

  it('parses a single push ref line', () => {
    expect(parsePushReferences('refs/heads/main localsha refs/heads/main remotesha')).toEqual([
      {
        localRef: 'refs/heads/main',
        localSha: 'localsha',
        remoteRef: 'refs/heads/main',
        remoteSha: 'remotesha',
      },
    ]);
  });

  it('parses multiple push ref lines', () => {
    const references = parsePushReferences(
      'refs/heads/a a2 refs/heads/a a1\nrefs/heads/b b2 refs/heads/b b1'
    );
    expect(references).toHaveLength(2);
    expect(references[1]!.localSha).toBe('b2');
  });

  it('fills missing fields with empty strings for a short line', () => {
    expect(parsePushReferences('refs/heads/main localsha')).toEqual([
      { localRef: 'refs/heads/main', localSha: 'localsha', remoteRef: '', remoteSha: '' },
    ]);
  });
});

describe('computePushedRange', () => {
  it('returns a remote..local range for an updated branch', () => {
    expect(
      computePushedRange(
        [
          {
            localRef: 'refs/heads/main',
            localSha: 'localsha',
            remoteRef: 'refs/heads/main',
            remoteSha: 'remotesha',
          },
        ],
        []
      )
    ).toEqual({ revisions: ['remotesha..localsha'], logOptions: 'remotesha..localsha' });
  });

  it('returns a remote..local range for a force-push that rewrote the remote tip', () => {
    expect(
      computePushedRange(
        [
          {
            localRef: 'refs/heads/main',
            localSha: 'rewrittensha',
            remoteRef: 'refs/heads/main',
            remoteSha: 'discardedsha',
          },
        ],
        []
      )?.logOptions
    ).toBe('discardedsha..rewrittensha');
  });

  it('scans commits not already on the remote being pushed to for a new branch', () => {
    expect(
      computePushedRange(
        [
          {
            localRef: 'refs/heads/feat',
            localSha: 'localsha',
            remoteRef: 'refs/heads/feat',
            remoteSha: ZERO,
          },
        ],
        ['advertisedsha']
      )
    ).toEqual({
      revisions: ['localsha', '--not', 'advertisedsha', '--not'],
      logOptions: 'localsha --not advertisedsha --not',
    });
  });

  it('skips branch deletions', () => {
    expect(
      computePushedRange(
        [{ localRef: '', localSha: ZERO, remoteRef: 'refs/heads/gone', remoteSha: 'remotesha' }],
        []
      )
    ).toBeNull();
  });

  it('returns null for no references at all', () => {
    expect(computePushedRange([], [])).toBeNull();
  });

  it('joins multiple ranges into one log-opts string', () => {
    expect(
      computePushedRange(
        [
          { localRef: 'refs/heads/a', localSha: 'a2', remoteRef: 'refs/heads/a', remoteSha: 'a1' },
          { localRef: 'refs/heads/b', localSha: 'b2', remoteRef: 'refs/heads/b', remoteSha: ZERO },
        ],
        ['advertisedsha']
      )?.logOptions
    ).toBe('a1..a2 b2 --not advertisedsha --not');
  });

  it('drops a deleted ref from a push that also updates a branch', () => {
    expect(
      computePushedRange(
        [
          { localRef: '', localSha: ZERO, remoteRef: 'refs/heads/gone', remoteSha: 'remotesha' },
          { localRef: 'refs/heads/a', localSha: 'a2', remoteRef: 'refs/heads/a', remoteSha: 'a1' },
        ],
        []
      )?.revisions
    ).toEqual(['a1..a2']);
  });
});

describe('resolvePushedRange', () => {
  const lastCommit = { revisions: ['HEAD', '--not', 'HEAD^@'], logOptions: '-1' };

  it('falls back to the last commit when run from a TTY', () => {
    expect(resolvePushedRange('', true, [])).toEqual(lastCommit);
  });

  it('falls back to the last commit when stdin is empty', () => {
    expect(resolvePushedRange('', false, [])).toEqual(lastCommit);
  });

  it('falls back to the last commit when stdin is blank whitespace', () => {
    expect(resolvePushedRange('\n  \n', false, [])).toEqual(lastCommit);
  });

  it('prefers the TTY fallback over ref lines that arrived on stdin', () => {
    expect(
      resolvePushedRange('refs/heads/main localsha refs/heads/main remotesha', true, [])
    ).toEqual(lastCommit);
  });

  it('resolves the pushed range from stdin', () => {
    expect(
      resolvePushedRange('refs/heads/main localsha refs/heads/main remotesha', false, [])
        ?.logOptions
    ).toBe('remotesha..localsha');
  });

  it('resolves a new branch against the remote it is being pushed to', () => {
    expect(
      resolvePushedRange(`refs/heads/feat localsha refs/heads/feat ${ZERO}`, false, [
        'advertisedsha',
      ])?.logOptions
    ).toBe('localsha --not advertisedsha --not');
  });

  it('restores polarity after a new branch, so a range after it keeps its sense', () => {
    const range = computePushedRange(
      [
        {
          localRef: 'refs/heads/feat',
          localSha: 'b2',
          remoteRef: 'refs/heads/feat',
          remoteSha: ZERO,
        },
        {
          localRef: 'refs/heads/main',
          localSha: 'a2',
          remoteRef: 'refs/heads/main',
          remoteSha: 'a1',
        },
      ],
      ['advertisedsha']
    );
    // `--not` toggles for everything that follows it, so without the reset the
    // second ref's `a1..a2` is read inside out.
    expect(range?.revisions).toEqual(['b2', '--not', 'advertisedsha', '--not', 'a1..a2']);
  });

  it('returns null when only deletions are pushed', () => {
    expect(
      resolvePushedRange(`refs/heads/gone ${ZERO} refs/heads/gone remotesha`, false, [])
    ).toBeNull();
  });
});

/**
 * The remote scoping is the whole point of the range, so it is pinned against
 * real git rather than against the string: a developer with a fork and an
 * upstream is ordinary here, and the unscoped form subtracts every commit on
 * *any* remote — which enumerates nothing at all for the push that most needs
 * scanning.
 */
describe('the range against real repositories', () => {
  const workspaces: string[] = [];

  afterAll(async () => {
    await Promise.all(workspaces.map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function twoRemoteClone(): Promise<{ directory: string; head: string }> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pushed-range-'));
    workspaces.push(directory);
    const work = path.join(directory, 'work');
    const run = async (cwd: string, args: readonly string[]): Promise<string> => {
      const result = await execa('git', [...args], { cwd });
      return result.stdout.trim();
    };

    for (const name of ['first.git', 'second.git']) {
      await fs.mkdir(path.join(directory, name), { recursive: true });
      await run(directory, ['init', '--bare', '-q', '-b', 'main', name]);
    }
    await fs.mkdir(work, { recursive: true });
    await run(work, ['init', '-q', '-b', 'main']);
    await run(work, ['config', 'user.email', 'agent@hushbox.ai']);
    await run(work, ['config', 'user.name', 'agent']);
    await fs.writeFile(path.join(work, 'file.txt'), 'content\n');
    await run(work, ['add', 'file.txt']);
    await run(work, ['commit', '-qm', 'first']);
    await run(work, ['remote', 'add', 'first', path.join(directory, 'first.git')]);
    await run(work, ['remote', 'add', 'second', path.join(directory, 'second.git')]);
    // The commit exists on `second` and nowhere else: pushing the branch to
    // `first` still publishes it there.
    await run(work, ['push', '-q', 'second', 'main']);
    await run(work, ['fetch', '-q', 'second']);
    return { directory: work, head: await run(work, ['rev-parse', 'HEAD']) };
  }

  /** What the destination holds, in the form the range builder takes. */
  async function advertised(cwd: string, destination: string): Promise<string[]> {
    const answer = await advertisedObjectIds(cwd, destination);
    if (!answer.established) throw new Error(`the destination did not answer: ${answer.reason}`);
    return answer.objectIds;
  }

  it('enumerates commits the destination does not hold, wherever else they sit', async () => {
    const { directory, head } = await twoRemoteClone();
    const range = computePushedRange(
      [
        {
          localRef: 'refs/heads/main',
          localSha: head,
          remoteRef: 'refs/heads/main',
          remoteSha: ZERO,
        },
      ],
      await advertised(directory, path.join(directory, '..', 'first.git'))
    );
    const { stdout } = await execa('git', ['rev-list', ...range!.revisions], { cwd: directory });
    expect(stdout.trim().split('\n')).toEqual([head]);
  });

  it('reports the ids a destination advertises that this clone can walk from', async () => {
    const { directory, head } = await twoRemoteClone();
    // `second` holds the commit; `first` holds nothing. Asking each of them is
    // the difference between a boundary and a guess.
    const holding = await advertisedObjectIds(directory, path.join(directory, '..', 'second.git'));
    const empty = await advertisedObjectIds(directory, path.join(directory, '..', 'first.git'));
    expect(holding).toEqual({ established: true, objectIds: [head] });
    expect(empty).toEqual({ established: true, objectIds: [] });
  });

  it('reports that a destination it cannot reach did not answer', async () => {
    const { directory } = await twoRemoteClone();
    const answer = await advertisedObjectIds(directory, path.join(directory, '..', 'absent.git'));
    expect(answer.established).toBe(false);
  });

  it('reports that no destination at all cannot answer', async () => {
    const { directory } = await twoRemoteClone();
    await expect(advertisedObjectIds(directory, '')).resolves.toMatchObject({
      established: false,
    });
  });

  it('enumerates both refs when a new branch is pushed alongside an updated one', async () => {
    const { directory } = await twoRemoteClone();
    const run = async (args: readonly string[]): Promise<string> => {
      const result = await execa('git', [...args], { cwd: directory });
      return result.stdout.trim();
    };
    await run(['checkout', '-q', '-b', 'feat']);
    await run(['commit', '-q', '--allow-empty', '-m', 'on the new branch']);
    const feat = await run(['rev-parse', 'HEAD']);
    await run(['checkout', '-q', 'main']);
    const published = await run(['rev-parse', 'HEAD']);
    await run(['commit', '-q', '--allow-empty', '-m', 'on the updated branch']);
    const main = await run(['rev-parse', 'HEAD']);

    const range = computePushedRange(
      [
        {
          localRef: 'refs/heads/feat',
          localSha: feat,
          remoteRef: 'refs/heads/feat',
          remoteSha: ZERO,
        },
        {
          localRef: 'refs/heads/main',
          localSha: main,
          remoteRef: 'refs/heads/main',
          remoteSha: published,
        },
      ],
      await advertised(directory, path.join(directory, '..', 'first.git'))
    );
    const listed = await run(['rev-list', ...range!.revisions]);
    const enumerated = listed.split('\n');
    expect(enumerated).toContain(feat);
    expect(enumerated).toContain(main);
  });
});

/**
 * The fail-closed posture, against a destination that accepts a connection and
 * never answers. The bound is injected so the property is testable in a suite
 * rather than in half a minute of wall clock.
 */
describe('the reason a refusal carries', () => {
  it('names the bound when the destination ran out of time', () => {
    expect(advertisementFailure({ timedOut: true, stderr: '' }, 750)).toContain('750');
  });

  it('says something when the failure came with no diagnosis at all', () => {
    // A refusal whose reason is empty ends at a colon and tells nobody anything,
    // which is how the fail-closed posture came to have no observable content.
    expect(advertisementFailure({ timedOut: false, stderr: '' }, 750)).not.toBe('');
  });

  it('passes the first line of the failure through when there is one', () => {
    expect(
      advertisementFailure({ timedOut: false, stderr: 'fatal: repository not found\nmore' }, 750)
    ).toBe('fatal: repository not found');
  });
});

describe('a destination that never answers', () => {
  const listeners: Server[] = [];
  const accepted: Socket[] = [];

  afterAll(() => {
    // A listener that never answers still holds its accepted sockets, and
    // `close` waits for them: tearing the sockets down first is what keeps this
    // fixture from hanging its own suite.
    for (const socket of accepted) socket.destroy();
    for (const listener of listeners) listener.close();
  });

  async function silentListener(): Promise<number> {
    const listener = createServer((socket) => {
      // Accept the connection and answer nothing, which is what a wedged
      // destination does and what a refused connection does not.
      accepted.push(socket);
    });
    listener.unref();
    listeners.push(listener);
    await new Promise<void>((resolve) => {
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  it('refuses, with a reason a developer can act on', async () => {
    const port = await silentListener();
    const answer = await advertisedObjectIds(process.cwd(), `git://127.0.0.1:${String(port)}/x`, {
      timeoutMs: 750,
    });
    expect(answer.established).toBe(false);
    // The reason is the half that was missing: a refusal ending at a colon
    // tells the developer nothing about what to do next.
    expect(answer.established ? '' : answer.reason).not.toBe('');
  });

  it('gives up inside the bound it was given', async () => {
    const port = await silentListener();
    const started = performance.now();
    await advertisedObjectIds(process.cwd(), `git://127.0.0.1:${String(port)}/x`, {
      timeoutMs: 750,
    });
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
