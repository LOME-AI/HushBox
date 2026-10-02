import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { tryLock } from './lib/claims/claim.js';
import { buildLeasePath } from './lib/bundling/lease.js';
import { runBuild, runPreviewServers } from './preview.js';
import type { LongLivedChild, spawnLongLived } from './lib/spawn/long-lived.js';

const mockExeca = vi.mocked(execa);

const ENV: NodeJS.ProcessEnv = {
  HB_PREVIEW_PORT: '10200',
  HB_API_PORT: '10400',
  HB_API_INSPECTOR_PORT: '13100',
};

interface FakeChild extends LongLivedChild {
  readonly killed: () => boolean;
}

/**
 * A child that ends on its own with `ends`, or — given nothing — one that runs
 * until it is killed, which is what a real server does.
 */
function fakeChild(ends?: number): FakeChild {
  let killed = false;
  let settle: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    settle = resolve;
  });
  if (ends !== undefined) settle(ends);
  return {
    pid: 4242,
    pgid: 4242,
    exit,
    kill: (): Promise<number> => {
      killed = true;
      settle(0);
      return exit;
    },
    killed: () => killed,
  };
}

interface SpawnCall {
  readonly args: readonly string[];
  readonly ports: readonly number[];
}

/** Hands back the given children in order, so a test can decide which one ends. */
function spawner(children: readonly FakeChild[]): {
  spawn: typeof spawnLongLived;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: typeof spawnLongLived = (_file, args, options) => {
    calls.push({ args, ports: options.ports });
    const started = children[calls.length - 1];
    if (started === undefined) throw new Error(`no child staged for spawn ${String(calls.length)}`);
    return Promise.resolve(started);
  };
  return { spawn, calls };
}

describe('runBuild', () => {
  let repoRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('runs pnpm --filter @hushbox/web build, naming no mode of its own', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never);
    await runBuild(repoRoot);
    expect(mockExeca).toHaveBeenCalledWith('pnpm', ['--filter', '@hushbox/web', 'build'], {
      stdio: 'inherit',
    });
  });

  it('holds the build lease while it builds', async () => {
    let heldDuringBuild = false;
    mockExeca.mockImplementation((async () => {
      const probe = await tryLock(buildLeasePath(repoRoot, 'web-dist'));
      heldDuringBuild = probe.held;
      return { exitCode: 0 };
    }) as never);
    await runBuild(repoRoot);
    expect(heldDuringBuild).toBe(true);
  });

  it('releases the build lease before serving', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never);
    await runBuild(repoRoot);
    // The lease file outlives the lease: the claim releases the OS lock on it
    // and leaves the file in place, because unlinking a lock file lets a
    // waiter and the next acquirer end up holding two different inodes.
    const probe = await tryLock(buildLeasePath(repoRoot, 'web-dist'));
    expect(probe.held).toBe(false);
  });
});

describe('runPreviewServers', () => {
  it('starts the api dev server and the built web bundle side by side', async () => {
    const { spawn, calls } = spawner([fakeChild(0), fakeChild()]);

    await runPreviewServers(ENV, spawn, () => {});

    expect(calls[0]?.args.slice(0, 3)).toEqual(['--filter', '@hushbox/api', 'dev']);
    expect(calls[1]?.args.slice(0, 3)).toEqual(['--filter', '@hushbox/web', 'preview']);
  });

  it('binds the web preview to the port it claims for it', async () => {
    const { spawn, calls } = spawner([fakeChild(0), fakeChild()]);

    await runPreviewServers(ENV, spawn, () => {});

    expect(calls[1]?.args).toEqual([
      '--filter',
      '@hushbox/web',
      'preview',
      '--port',
      '10200',
      '--open',
    ]);
    expect(calls[1]?.ports).toEqual([10_200]);
  });

  it("claims both of the api server's ports, which one command starts", async () => {
    const { spawn, calls } = spawner([fakeChild(0), fakeChild()]);

    await runPreviewServers(ENV, spawn, () => {});

    expect(calls[0]?.ports).toEqual([10_400, 13_100]);
  });

  it('names each server and its ports as it starts, so interleaved output reads', async () => {
    const lines: string[] = [];
    const { spawn } = spawner([fakeChild(0), fakeChild()]);

    await runPreviewServers(ENV, spawn, (line) => lines.push(line));

    expect(lines).toEqual([
      'preview: @hushbox/api dev on 10400, 13100',
      'preview: @hushbox/web preview on 10200',
    ]);
  });

  it('writes each line to standard output when the caller names no reporter', async () => {
    const { spawn } = spawner([fakeChild(0), fakeChild()]);
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write');
    stdout.mockImplementation((chunk) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    try {
      await runPreviewServers(ENV, spawn);
    } finally {
      stdout.mockRestore();
    }

    expect(written).toContain('preview: @hushbox/web preview on 10200\n');
  });

  it('ends the other server when one of them exits', async () => {
    const stopped = fakeChild(0);
    const other = fakeChild();
    const { spawn } = spawner([stopped, other]);

    await runPreviewServers(ENV, spawn, () => {});

    expect(other.killed()).toBe(true);
  });

  it('fails the command when a server fails', async () => {
    const { spawn } = spawner([fakeChild(3), fakeChild()]);

    await expect(runPreviewServers(ENV, spawn, () => {})).resolves.toBe(3);
  });

  it('ends what it already started when a later server cannot be claimed', async () => {
    const started = fakeChild();
    const { spawn } = spawner([started]);

    await expect(
      runPreviewServers({ HB_API_PORT: '10400', HB_API_INSPECTOR_PORT: '13100' }, spawn, () => {})
    ).rejects.toThrow('HB_PREVIEW_PORT');
    expect(started.killed()).toBe(true);
  });
});
