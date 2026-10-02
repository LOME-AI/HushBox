import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { untilObserved } from '../bounded-wait.setup.js';
import {
  HELD_CLAIMS_ENV,
  PROGRESS_INTERVAL_MS,
  claim,
  tryLock,
  type ClaimResource,
  type OnHeld,
} from './claim.js';
import type { Readable, Writable } from 'node:stream';

/**
 * The claim's whole premise is that liveness is a kernel fact, and only a real
 * second process can be frozen or killed to show it. The holder runs through
 * tsx's loader in-process (`--import`) rather than through its CLI, which forks:
 * a signal has to reach the process that actually holds the lock.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const HOLDER_ENTRY = fileURLToPath(new URL('claim-holder-entry.mjs', import.meta.url));

/** What `spawn` returns for the fixture's `['pipe', 'pipe', 'inherit']` streams. */
type HolderProcess = ChildProcessByStdio<Writable, Readable, null>;

let workDir: string;
let holders: HolderProcess[];

function resource(name = 'web-dist'): ClaimResource {
  return { name, lockPath: path.join(workDir, `${name}.lock`) };
}

function waitForExit(child: HolderProcess): Promise<void> {
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

/**
 * The ceiling on a poll, held in wall-clock time rather than in attempts: an
 * attempt count buys however much time the host's scheduler decides to give it,
 * while what each caller here waits for is the claim's own progress line, due no
 * later than one {@link PROGRESS_INTERVAL_MS} after the wait begins; a caller that
 * injects a shorter progress interval sees its line sooner, and one that injects
 * none waits the constant. Two cadences leaves a whole cadence of slack for a
 * timer the host delivers late, and stays inside the tightest timeout the runner
 * imposes on a case, so where a case asserts on the line, a line that never comes
 * fails on that assertion rather than on the runner's clock.
 *
 * A wait to it ends either way: a case that needs the condition held asserts it
 * afterwards, and one waiting only to sequence a release does not.
 */
const WAIT_CEILING_MS = 2 * PROGRESS_INTERVAL_MS;

interface Holder {
  readonly child: HolderProcess;
  /** `held` or `refused` — what the claim did in the other process. */
  readonly outcome: string;
  release(): Promise<void>;
}

/** Starts a holder and resolves once it reports what the claim did. */
async function startHolder(
  target: ClaimResource,
  holder: string,
  options: { readonly onHeld?: OnHeld; readonly inheritClaims?: boolean } = {}
): Promise<Holder> {
  const inherited = process.env[HELD_CLAIMS_ENV] ?? '';
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      HOLDER_ENTRY,
      target.lockPath,
      target.name,
      holder,
      options.onHeld ?? 'refuse',
    ],
    {
      env: {
        ...process.env,
        [HELD_CLAIMS_ENV]: options.inheritClaims === true ? inherited : '',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  );
  holders.push(child);

  const outcome = await new Promise<string>((resolve, reject) => {
    let seen = '';
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      const newline = seen.indexOf('\n');
      if (newline !== -1) resolve(seen.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', () => {
      resolve(seen.trim());
    });
  });

  return {
    child,
    outcome,
    async release(): Promise<void> {
      child.stdin.write('go\n');
      await waitForExit(child);
    },
  };
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-liveness-'));
  holders = [];
});

afterEach(async () => {
  for (const child of holders) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('liveness under signals', () => {
  it('reports a claim whose holder was killed as free', async () => {
    const target = resource();
    const holder = await startHolder(target, 'pnpm dev');
    expect(holder.outcome).toBe('held');

    holder.child.kill('SIGKILL');
    await waitForExit(holder.child);

    expect(await tryLock(target.lockPath)).toEqual({ held: false, holder: null });
  });

  it('reports a frozen holder as still alive', async () => {
    const target = resource();
    const holder = await startHolder(target, 'pnpm dev');
    expect(holder.outcome).toBe('held');

    holder.child.kill('SIGSTOP');

    expect(await tryLock(target.lockPath)).toEqual({ held: true, holder: 'pnpm dev' });
    holder.child.kill('SIGCONT');
  });

  it('names an unidentifiable holder rather than failing to name one', async () => {
    const target = resource();
    const holder = await startHolder(target, '');
    expect(holder.outcome).toBe('held');

    expect(await tryLock(target.lockPath)).toEqual({ held: true, holder: 'another run' });
  });

  it('reports a claim its holder released on a clean exit as free', async () => {
    const target = resource();
    const holder = await startHolder(target, 'pnpm dev');
    await holder.release();

    expect(await tryLock(target.lockPath)).toEqual({ held: false, holder: null });
  });
});

describe('claim in refuse mode across processes', () => {
  it('refuses a second run while another process holds the claim', async () => {
    const target = resource();
    await startHolder(target, 'pnpm dev');

    const refused = await startHolder(target, 'pnpm build');

    expect(refused.outcome).toBe('refused');
  });
});

describe('claim in wait mode', () => {
  it('queues behind a live holder and runs once it releases', async () => {
    const target = resource();
    const holder = await startHolder(target, 'pnpm dev');
    const lines: string[] = [];

    const queued = claim(
      target,
      {
        onHeld: 'wait',
        holder: 'pnpm test',
        log: (line) => lines.push(line),
        progressIntervalMs: 20,
      },
      () => Promise.resolve('ran')
    );

    await untilObserved(() => lines.length > 0, WAIT_CEILING_MS);
    await holder.release();

    await expect(queued).resolves.toBe('ran');
  });

  it('reports the holder it is waiting for and how long it has waited', async () => {
    const target = resource();
    const holder = await startHolder(target, 'pnpm dev');
    const lines: string[] = [];

    const queued = claim(
      target,
      {
        onHeld: 'wait',
        holder: 'pnpm test',
        log: (line) => lines.push(line),
        progressIntervalMs: 20,
      },
      () => Promise.resolve('ran')
    );

    await untilObserved(() => lines.length > 0, WAIT_CEILING_MS);
    await holder.release();
    await queued;

    expect(lines[0]).toMatch(/web-dist/);
    expect(lines[0]).toMatch(/pnpm dev/);
    expect(lines[0]).toMatch(/\(\d+s\)/);
  });

  it('reports to standard error on its own cadence when given neither', async () => {
    const target = resource();
    const holder = await startHolder(target, 'pnpm dev');
    const lines: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });

    const queued = claim(target, { onHeld: 'wait', holder: 'pnpm test' }, () =>
      Promise.resolve('ran')
    );

    await untilObserved(() => lines.length > 0, WAIT_CEILING_MS);
    await holder.release();
    await queued;
    errors.mockRestore();

    expect(lines[0]).toMatch(/pnpm dev/);
  }, 30_000);
});

describe('inherited re-entrancy', () => {
  it('lets a child process through a claim its parent holds', async () => {
    const target = resource();
    let childOutcome = '';

    await claim(target, { onHeld: 'refuse', holder: 'pnpm dev' }, async () => {
      const child = await startHolder(target, 'nested build', { inheritClaims: true });
      childOutcome = child.outcome;
      await child.release();
    });

    expect(childOutcome).toBe('held');
  });

  it('still refuses a child process that inherited nothing', async () => {
    const target = resource();
    let childOutcome = '';

    await claim(target, { onHeld: 'refuse', holder: 'pnpm dev' }, async () => {
      const child = await startHolder(target, 'nested build');
      childOutcome = child.outcome;
    });

    expect(childOutcome).toBe('refused');
  });
});
