import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClaimHeldError, HELD_CLAIMS_ENV } from '../claims/claim.js';
import {
  READ_ONLY_LOCAL_CACHE,
  TURBO_CACHE_VARIABLE,
  asElectedCacheWriter,
  cacheWriterLockPath,
} from './cache-writer.js';
import type { Readable, Writable } from 'node:stream';

/**
 * A loser is only a loser against a seat some other run holds, and a claim is a
 * kernel fact about a process rather than a value a stub can stand in for. The
 * fixture that holds one belongs to the claim primitive, and is reused rather
 * than copied.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const HOLDER_ENTRY = fileURLToPath(new URL('../claims/claim-holder-entry.mjs', import.meta.url));

type HolderProcess = ChildProcessByStdio<Writable, Readable, null>;

let rootDir: string;
let holders: HolderProcess[];

/** Starts a run that holds the writer's seat, and resolves once it holds it. */
async function startSeatHolder(): Promise<{ release(): Promise<void> }> {
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, HOLDER_ENTRY, cacheWriterLockPath(rootDir), 'seat', 'other', 'refuse'],
    {
      // Never inherited: an inherited claim is one this process already holds,
      // and the fixture has to meet the lock rather than walk past it.
      env: { ...process.env, [HELD_CLAIMS_ENV]: '' },
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  );
  holders.push(child);

  await new Promise<void>((resolve, reject) => {
    let seen = '';
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes('\n')) resolve();
    });
    child.once('error', reject);
  });

  return {
    async release(): Promise<void> {
      child.stdin.write('go\n');
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
      });
    },
  };
}

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-writer-'));
  holders = [];
});

afterEach(async () => {
  for (const child of holders) child.kill('SIGKILL');
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('asElectedCacheWriter', () => {
  it('leaves the cache unrestricted for the run that takes the seat', async () => {
    const env: NodeJS.ProcessEnv = {};

    await asElectedCacheWriter({ rootDir, command: 'lint', env }, async () => {
      await Promise.resolve();
      expect(env[TURBO_CACHE_VARIABLE]).toBeUndefined();
    });
  });

  it('restricts the cache to reads for a run that finds the seat taken', async () => {
    const seat = await startSeatHolder();
    const env: NodeJS.ProcessEnv = {};

    await asElectedCacheWriter({ rootDir, command: 'lint', env }, async () => {
      await Promise.resolve();
      expect(env[TURBO_CACHE_VARIABLE]).toBe(READ_ONLY_LOCAL_CACHE);
    });

    await seat.release();
  });

  it('runs the body rather than refusing when the seat is taken', async () => {
    const seat = await startSeatHolder();

    const answer = await asElectedCacheWriter({ rootDir, command: 'lint', env: {} }, () =>
      Promise.resolve('ran')
    );

    expect(answer).toBe('ran');
    await seat.release();
  });

  it('gives the variable back what it found there', async () => {
    const env: NodeJS.ProcessEnv = { [TURBO_CACHE_VARIABLE]: 'remote:rw' };

    await asElectedCacheWriter({ rootDir, command: 'lint', env }, () => Promise.resolve());

    expect(env[TURBO_CACHE_VARIABLE]).toBe('remote:rw');
  });

  it('leaves the variable unset where it found it unset', async () => {
    const seat = await startSeatHolder();
    const env: NodeJS.ProcessEnv = {};

    await asElectedCacheWriter({ rootDir, command: 'lint', env }, () => Promise.resolve());

    expect(env[TURBO_CACHE_VARIABLE]).toBeUndefined();
    await seat.release();
  });

  it('releases the seat once the body ends', async () => {
    await asElectedCacheWriter({ rootDir, command: 'lint', env: {} }, () => Promise.resolve());

    const env: NodeJS.ProcessEnv = {};
    await asElectedCacheWriter({ rootDir, command: 'lint', env }, async () => {
      await Promise.resolve();
      expect(env[TURBO_CACHE_VARIABLE]).toBeUndefined();
    });
  });

  it("takes this process's own environment where none was named", async () => {
    const seat = await startSeatHolder();
    process.env[TURBO_CACHE_VARIABLE] = 'remote:rw';
    let modeSeen: string | undefined;

    try {
      await asElectedCacheWriter({ rootDir, command: 'lint' }, async () => {
        await Promise.resolve();
        modeSeen = process.env[TURBO_CACHE_VARIABLE];
      });

      expect(modeSeen).toBe(READ_ONLY_LOCAL_CACHE);
      expect(process.env[TURBO_CACHE_VARIABLE]).toBe('remote:rw');
    } finally {
      Reflect.deleteProperty(process.env, TURBO_CACHE_VARIABLE);
      await seat.release();
    }
  });

  it('raises a refusal the body itself made instead of running the body again', async () => {
    let runs = 0;

    await expect(
      asElectedCacheWriter({ rootDir, command: 'build', env: {} }, () => {
        runs += 1;
        return Promise.reject(new ClaimHeldError('web-dist', 'another build'));
      })
    ).rejects.toBeInstanceOf(ClaimHeldError);

    expect(runs).toBe(1);
  });

  it('raises whatever else the body raised', async () => {
    await expect(
      asElectedCacheWriter({ rootDir, command: 'build', env: {} }, () =>
        Promise.reject(new Error('the task failed'))
      )
    ).rejects.toThrow('the task failed');
  });
});
