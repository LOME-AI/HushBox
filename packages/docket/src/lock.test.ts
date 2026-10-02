import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaimHeldError, HELD_CLAIMS_ENV } from '../../../scripts/lib/claims/claim.ts';
import { LockUnavailableError, withLockFile } from './lock.ts';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * The holder runs through tsx's loader in-process (`--import`) rather than
 * through its CLI, which forks: a signal has to reach the process that actually
 * holds the lock, and the loader is what lets a plain node process import the
 * TypeScript module under test.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const HOLDER_ENTRY = fileURLToPath(new URL('lock-holder-entry.mjs', import.meta.url));

/** What `spawn` returns for the fixture's `['pipe', 'pipe', 'inherit']` streams. */
type HolderProcess = ChildProcessByStdio<Writable, Readable, null>;

let root: string;
let lockPath: string;
let holders: HolderProcess[];

/** One attempt and no patience, so an outcome cannot be a wait that timed out. */
const IMMEDIATE = { timeoutMs: 0, retryMs: 5 } as const;
/** Long enough for a contended section to hand over, short enough to fail fast. */
const FAST = { timeoutMs: 500, retryMs: 5 } as const;

/**
 * A holder must lead its own process group on POSIX, or the `SIGSTOP` below
 * suspends the test runner along with it: a stopped member of the runner's own
 * group takes the runner down. On Windows `detached` would remove the job
 * object libuv otherwise gives a child, which is the only automatic cleanup
 * available there; Playwright spells the same branch the same way.
 */
function holderSpawnOptions(platform: NodeJS.Platform): { readonly detached: boolean } {
  return { detached: platform !== 'win32' };
}

function exited(child: HolderProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => {
      resolve();
    });
  });
}

interface Holder {
  readonly child: HolderProcess;
  exited(): Promise<void>;
}

/** Starts a holder and resolves once it reports the lock is its. */
async function startHolder(target: string): Promise<Holder> {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, HOLDER_ENTRY, target], {
    // Never the claims this process inherited: a holder that believed it had
    // already been granted the lock would report `held` without taking one.
    env: { ...process.env, [HELD_CLAIMS_ENV]: '' },
    stdio: ['pipe', 'pipe', 'inherit'],
    ...holderSpawnOptions(process.platform),
  });
  holders.push(child);

  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve();
    });
    child.once('error', reject);
    child.once('exit', () => {
      reject(new Error('the holder exited before it took the lock'));
    });
  });

  return { child, exited: () => exited(child) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-lock-'));
  lockPath = path.join(root, 'AI-1.md.lock');
  holders = [];
});

afterEach(async () => {
  for (const child of holders) {
    // SIGCONT first: a frozen process never observes SIGKILL until it runs.
    child.kill('SIGCONT');
    child.kill('SIGKILL');
    await exited(child);
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('withLockFile', () => {
  it('runs the callback and returns its value', async () => {
    expect(await withLockFile(lockPath, () => Promise.resolve('done'), FAST)).toBe('done');
  });

  it('holds the lock for the length of the callback', async () => {
    await withLockFile(
      lockPath,
      async () => {
        await expect(
          withLockFile(lockPath, () => Promise.resolve('inner'), IMMEDIATE)
        ).rejects.toBeInstanceOf(LockUnavailableError);
      },
      FAST
    );
  });

  it('hands the lock on when the callback returns', async () => {
    await withLockFile(lockPath, () => Promise.resolve(), FAST);
    expect(await withLockFile(lockPath, () => Promise.resolve('next'), IMMEDIATE)).toBe('next');
  });

  it('hands the lock on when the callback throws', async () => {
    await expect(
      withLockFile(lockPath, () => Promise.reject(new Error('boom')), FAST)
    ).rejects.toThrow('boom');
    expect(await withLockFile(lockPath, () => Promise.resolve('next'), IMMEDIATE)).toBe('next');
  });

  it('keeps two callbacks from overlapping', async () => {
    const order: string[] = [];
    const section = async (name: string): Promise<void> => {
      order.push(`${name}-in`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`${name}-out`);
    };

    await Promise.all([
      withLockFile(lockPath, async () => section('a'), FAST),
      withLockFile(lockPath, async () => section('b'), FAST),
    ]);

    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out']);
  });

  it('takes a lock file no process holds rather than waiting it out', async () => {
    await fs.writeFile(lockPath, 'a writer that is long gone');

    expect(await withLockFile(lockPath, () => Promise.resolve('ran'), IMMEDIATE)).toBe('ran');
  });

  it('leaves the lock file in place rather than unlinking it', async () => {
    await withLockFile(lockPath, () => Promise.resolve(), FAST);

    expect(await exists(lockPath)).toBe(true);
  });

  it('refuses rather than run past a live holder that never lets go', async () => {
    await startHolder(lockPath);
    let ran = false;

    await expect(
      withLockFile(
        lockPath,
        () => {
          ran = true;
          return Promise.resolve('ran');
        },
        FAST
      )
    ).rejects.toBeInstanceOf(LockUnavailableError);
    expect(ran).toBe(false);
  });

  it('surfaces a lock path that cannot be created at all', async () => {
    await expect(
      withLockFile(path.join(root, 'missing', 'AI-1.md.lock'), () => Promise.resolve('ran'), FAST)
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces a lock path that cannot be opened at all', async () => {
    await fs.mkdir(lockPath);

    await expect(withLockFile(lockPath, () => Promise.resolve('ran'), FAST)).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('reports a callback that refuses a claim of its own rather than retrying it', async () => {
    await expect(
      withLockFile(lockPath, () => Promise.reject(new ClaimHeldError('elsewhere', 'someone')), FAST)
    ).rejects.toBeInstanceOf(ClaimHeldError);
  });
});

describe('liveness under signals', () => {
  it('keeps the lock for a holder that is frozen rather than finished', async () => {
    const holder = await startHolder(lockPath);

    // A frozen process writes nothing, so anything reading a clock reports it
    // dead and breaks in on a live holder. Its lock is a kernel fact and
    // outlives the freeze.
    holder.child.kill('SIGSTOP');

    await expect(
      withLockFile(lockPath, () => Promise.resolve('stolen'), FAST)
    ).rejects.toBeInstanceOf(LockUnavailableError);
    holder.child.kill('SIGCONT');
  });

  it('frees the lock as soon as its holder is killed', async () => {
    const holder = await startHolder(lockPath);

    holder.child.kill('SIGKILL');
    await holder.exited();

    // No wait and no window: the kernel dropped the lock with the process.
    expect(await withLockFile(lockPath, () => Promise.resolve('reclaimed'), IMMEDIATE)).toBe(
      'reclaimed'
    );
  });
});

describe('the holder harness platform branch', () => {
  // Both cases prove which branch a platform string selects, and nothing about
  // how either operating system behaves: nothing in this suite runs on Windows.
  it('gives a POSIX holder a process group of its own', () => {
    expect(holderSpawnOptions('linux')).toEqual({ detached: true });
  });

  it('leaves a Windows holder in the job object libuv gives it', () => {
    expect(holderSpawnOptions('win32')).toEqual({ detached: false });
  });
});
