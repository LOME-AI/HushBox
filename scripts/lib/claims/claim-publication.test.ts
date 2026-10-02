import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV, tryLock } from './claim.js';
import type { Readable, Writable } from 'node:stream';

/**
 * The window between a claim being granted and its holder being written is a
 * window between two operations in another process, so only real processes
 * running beside the probe can put it there. The churners run through tsx's
 * loader in-process (`--import`) rather than through its CLI, which forks.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CHURN_ENTRY = fileURLToPath(new URL('claim-churn-entry.mjs', import.meta.url));

/**
 * What the processes taking and releasing each claim call themselves. The
 * lengths differ deliberately: a name written over a longer one has to leave no
 * part of that one readable, so equal-length names would hide half of what the
 * probe must read correctly.
 */
const NAMES = [
  'pnpm dev',
  'pnpm build:e2e:admin',
  'pnpm test:pkg @hushbox/scripts',
  // Long enough that a reader sizing its read before the name grew comes back
  // holding a fragment of it, which is the other way a name reads as no name.
  `pnpm e2e ${'-'.repeat(4000)}`,
] as const;

/**
 * How many rounds they run. Each round is a claim none of them has taken
 * before, which is the state a claim is in when nothing has yet named a holder
 * in it, and then changes hands between them inside the round.
 */
const ROUNDS = 120;

type ChurnProcess = ChildProcessByStdio<Writable, Readable, null>;

interface Churner {
  readonly child: ChurnProcess;
  /** Sends the round to take, and resolves once this churner has finished it. */
  run(round: number): Promise<void>;
}

let workDir: string;
let churners: ChurnProcess[];

/** The claim of one round, spelled the way the churn fixture spells it. */
function roundLockPath(dir: string, round: number): string {
  return path.join(dir, `round-${String(round)}.lock`);
}

function waitForExit(child: ChurnProcess): Promise<void> {
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

/** Starts one churner and resolves once it says it has started churning. */
async function startChurner(dir: string, holder: string): Promise<Churner> {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CHURN_ENTRY, dir, holder], {
    // The invocation running this suite holds claims of its own and advertises
    // them to every child, and a churner that inherited one would walk through
    // the claim instead of taking it.
    env: { ...process.env, [HELD_CLAIMS_ENV]: '' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  churners.push(child);

  let seen = '';
  let waiting: { readonly said: string; readonly resolve: () => void }[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    seen += chunk.toString();
    const said = waiting.filter((waiter) => seen.includes(waiter.said));
    waiting = waiting.filter((waiter) => !seen.includes(waiter.said));
    for (const waiter of said) waiter.resolve();
  });

  function hasSaid(said: string): Promise<void> {
    return new Promise((resolve) => {
      if (seen.includes(said)) {
        resolve();
        return;
      }
      waiting.push({ said, resolve });
      child.once('exit', () => {
        resolve();
      });
    });
  }

  await hasSaid('churning\n');
  return {
    child,
    async run(round: number): Promise<void> {
      child.stdin.write(`${String(round)}\n`);
      await hasSaid(`done ${String(round)}\n`);
    },
  };
}

beforeEach(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claim-publication-')));
  churners = [];
  vi.stubEnv(HELD_CLAIMS_ENV, '');
});

afterEach(async () => {
  for (const child of churners) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('a claim probed while other runs are taking and releasing it', () => {
  it('never takes part of a name as the holder', async () => {
    const running = await Promise.all(NAMES.map((name) => startChurner(workDir, name)));

    const observed = new Set<string>();
    let heldReadings = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const lockPath = roundLockPath(workDir, round);
      // An object rather than a plain flag: the probe below reads it after every
      // `await`, and the assignment it is watching for happens in a task the
      // narrowing of a `let` would not account for.
      const state = { settled: false };
      const taken = (async (): Promise<void> => {
        await Promise.all(running.map((churner) => churner.run(round)));
        state.settled = true;
      })();

      while (!state.settled) {
        const probe = await tryLock(lockPath);
        if (!probe.held) continue;
        heldReadings += 1;
        // A name the probe caught going in is the third answer, and it is a
        // correct one: it names nobody precisely because nothing whole was
        // there to name. Only what the probe handed back *as a name* is held
        // to naming a churner.
        if (probe.holderPending === true) continue;
        // A held claim with no holder at all is the reading this exists to
        // rule out, so it is recorded as one of the names it is not.
        observed.add(probe.holder ?? 'no holder');
      }
      await taken;
    }

    // Without a reading of a held claim the pass proves nothing, and without
    // one it accepted as a name it proves nothing either — a probe that called
    // every reading not-yet-readable would satisfy the property below while
    // naming nobody. Both are asserted before what the readings showed. Which
    // churner a reading catches holding is up to the scheduler; that every
    // name handed back is one of theirs is the property.
    expect(heldReadings).toBeGreaterThan(0);
    expect(observed.size).toBeGreaterThan(0);
    const names = new Set<string>(NAMES);
    expect([...observed].filter((holder) => !names.has(holder))).toEqual([]);
  }, 120_000);
});
