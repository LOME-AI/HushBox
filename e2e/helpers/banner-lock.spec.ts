import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test as base, expect } from '../fixtures.js';
import { ClaimHeldError } from '../../scripts/lib/claims/claim.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { BANNER_LOCK_TEST_TIMEOUT_MS, expectBannerReset, withBannerLock } from './banner-lock.js';
import type { BannerReset } from './banner-lock.js';
import type { CheckedResponse } from './ok-response.js';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The lock is a kernel fact about processes, exercised node-side against a temporary path. No page is opened, so no rendering engine participates.',
});

/**
 * The holder runs through tsx's loader in-process (`--import`) rather than
 * through its CLI, which forks: a signal has to reach the process that actually
 * owns the lock, and the loader is what lets a plain node process import the
 * helper's TypeScript.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const HOLDER_ENTRY = fileURLToPath(new URL('banner-lock-holder-entry.mjs', import.meta.url));

/** What `spawn` returns for the fixture's `['pipe', 'pipe', 'inherit']` streams. */
type HolderProcess = ChildProcessByStdio<Writable, Readable, null>;

interface Holder {
  readonly child: HolderProcess;
  /** Resolves once the other process has exited, however it ended. */
  exited(): Promise<void>;
}

/** Starts a holder process and resolves once it reports the row is its. */
type StartHolder = (lockPath: string) => Promise<Holder>;

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

/** Stands in for the dev reset route, so the helper's own tests never reach the API. */
const reachesNoApi: BannerReset = () => Promise.resolve();

/** The dev reset route's answer with `status`, as the reset's check reads it. */
function devRouteAnswer(status: number): CheckedResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    headers: () => ({ 'content-type': 'application/json' }),
    text: () => Promise.resolve('{}'),
  };
}

/** Answers whether another holder is refused the row right now. */
async function rowIsHeld(lockPath: string): Promise<boolean> {
  try {
    await withBannerLock(() => 'probe', { lockPath, onHeld: 'refuse', resetBanner: reachesNoApi });
    return false;
  } catch (error) {
    if (error instanceof ClaimHeldError) return true;
    throw error;
  }
}

interface ResetRecorder {
  readonly resetBanner: BannerReset;
  /** One entry per reset call: whether the row was still held when it was made. */
  readonly heldAtEachCall: boolean[];
}

/** A reset the dev route answers with `status`, recording each call it receives. */
function recordResets(lockPath: string, status: number): ResetRecorder {
  const heldAtEachCall: boolean[] = [];
  return {
    heldAtEachCall,
    resetBanner: async () => {
      heldAtEachCall.push(await rowIsHeld(lockPath));
      await expectBannerReset(devRouteAnswer(status));
    },
  };
}

const test = base.extend<{ lockPath: string; startHolder: StartHolder }>({
  // A private lock path per test, so these never touch the suite's real lock.
  // The directory holding it is removed in teardown, which runs on failure too.
  // eslint-disable-next-line no-empty-pattern -- the empty pattern is the only shape a dependency-free fixture can take
  lockPath: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hb-banner-lock-'));

    await use(path.join(directory, 'banner-config.lock'));

    await rm(directory, { recursive: true, force: true });
  },

  // Every holder this test started, killed in teardown so a frozen or wedged
  // one never outlives the test that made it. Cleanup lives here rather than in
  // the spec body so it runs on failure too.
  // eslint-disable-next-line no-empty-pattern -- the empty pattern is the only shape a dependency-free fixture can take
  startHolder: async ({}, use) => {
    const started: HolderProcess[] = [];

    await use(async (lockPath: string) => {
      const child = spawn(process.execPath, ['--import', TSX_LOADER, HOLDER_ENTRY, lockPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
        // Its own process group on POSIX, which is what keeps a SIGSTOP below
        // addressed to this holder alone: a stopped member of the runner's own
        // group suspends the runner with it. Playwright spells the same branch
        // the same way, and on Windows `detached` would remove the job object
        // libuv otherwise gives a child.
        detached: process.platform !== 'win32',
      });
      started.push(child);

      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('held')) resolve();
        });
        child.once('error', reject);
        child.once('exit', () => {
          reject(new Error('banner lock holder exited before it took the row'));
        });
      });

      return { child, exited: () => exited(child) };
    });

    for (const child of started) {
      // SIGCONT first: a frozen process never observes SIGKILL until it runs.
      child.kill('SIGCONT');
      child.kill('SIGKILL');
      await exited(child);
    }
  },
});

test.describe('Banner-row advisory lock', SPEC_MATRIX, () => {
  test.describe.configure({ timeout: BANNER_LOCK_TEST_TIMEOUT_MS });

  test('runs the guarded body and hands the row on when it ends', async ({ lockPath }) => {
    const held = await withBannerLock(() => 'ran', { lockPath, resetBanner: reachesNoApi });

    expect(held).toBe('ran');
    expect(
      await withBannerLock(() => 'next', {
        lockPath,
        onHeld: 'refuse',
        resetBanner: reachesNoApi,
      })
    ).toBe('next');
  });

  test('refuses a second holder while the row is held, naming the contended row', async ({
    lockPath,
  }) => {
    await withBannerLock(
      async () => {
        await expect(
          withBannerLock(() => 'inner', { lockPath, onHeld: 'refuse', resetBanner: reachesNoApi })
        ).rejects.toThrow(/banner_config/);
      },
      { lockPath, resetBanner: reachesNoApi }
    );
  });

  test('hands the row on when the guarded body throws', async ({ lockPath }) => {
    await expect(
      withBannerLock(
        (): never => {
          throw new Error('guarded body failed');
        },
        { lockPath, resetBanner: reachesNoApi }
      )
    ).rejects.toThrow('guarded body failed');

    expect(
      await withBannerLock(() => 'next', {
        lockPath,
        onHeld: 'refuse',
        resetBanner: reachesNoApi,
      })
    ).toBe('next');
  });

  test('keeps the row for a holder that is frozen rather than finished', async ({
    lockPath,
    startHolder,
  }) => {
    const holder = await startHolder(lockPath);

    // A frozen process writes nothing, so anything reading a clock reports it
    // dead and breaks in on a live holder. Its lock is a kernel fact and
    // outlives the freeze.
    holder.child.kill('SIGSTOP');

    await expect(
      withBannerLock(() => 'stolen', { lockPath, onHeld: 'refuse', resetBanner: reachesNoApi })
    ).rejects.toThrow(/banner_config/);
    holder.child.kill('SIGCONT');
  });

  test('frees the row as soon as its holder is killed', async ({ lockPath, startHolder }) => {
    const holder = await startHolder(lockPath);

    holder.child.kill('SIGKILL');
    await holder.exited();

    // No wait and no window: the kernel dropped the lock with the process.
    expect(
      await withBannerLock(() => 'reclaimed', {
        lockPath,
        onHeld: 'refuse',
        resetBanner: reachesNoApi,
      })
    ).toBe('reclaimed');
  });
  test('resets the banner exactly once, before handing the row on, when the body resolves', async ({
    lockPath,
  }) => {
    const recorder = recordResets(lockPath, 200);

    const held = await withBannerLock(() => 'ran', {
      lockPath,
      resetBanner: recorder.resetBanner,
    });

    expect(held).toBe('ran');
    expect(recorder.heldAtEachCall).toEqual([true]);
  });

  test('resets the banner exactly once, before handing the row on, when the body throws', async ({
    lockPath,
  }) => {
    const recorder = recordResets(lockPath, 200);

    await expect(
      withBannerLock(
        (): never => {
          throw new Error('guarded body failed');
        },
        { lockPath, resetBanner: recorder.resetBanner }
      )
    ).rejects.toThrow('guarded body failed');

    expect(recorder.heldAtEachCall).toEqual([true]);
  });

  test('fails the holder with the response of a reset that does not answer 200', async ({
    lockPath,
  }) => {
    const recorder = recordResets(lockPath, 429);

    await expect(
      withBannerLock(() => 'ran', { lockPath, resetBanner: recorder.resetBanner })
    ).rejects.toThrow(/^banner reset failed: 429 application\/json \{\}$/);
  });

  test('fails the holder when the reset answers a success other than 200', async ({ lockPath }) => {
    const recorder = recordResets(lockPath, 204);

    await expect(
      withBannerLock(() => 'ran', { lockPath, resetBanner: recorder.resetBanner })
    ).rejects.toThrow(/^banner reset failed: 204 /);
  });

  test('fails the holder with both errors when the body throws and the reset fails', async ({
    lockPath,
  }) => {
    const recorder = recordResets(lockPath, 500);

    const held = withBannerLock(
      (): never => {
        throw new Error('guarded body failed');
      },
      { lockPath, resetBanner: recorder.resetBanner }
    );

    await expect(held).rejects.toBeInstanceOf(AggregateError);
    await expect(held).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'guarded body failed' }),
        expect.objectContaining({ message: expect.stringMatching(/^banner reset failed: 500 /) }),
      ],
    });
  });
});
