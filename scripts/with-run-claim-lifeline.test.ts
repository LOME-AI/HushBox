import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUN_CLAIM_ENV } from './lib/claims/registry.js';
import { LIFELINE_ENV, closeProcessLifeline, killTree } from './lib/spawn/long-lived.js';
import {
  CHAIN_ANNOUNCEMENT_BUDGET_MS,
  CHAIN_CASE_TIMEOUT_MS,
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  SURVIVAL_WINDOW_MS,
  untilFileWritten,
  untilObserved,
  untilSettled,
} from './lib/bounded-wait.setup.js';
import { execStage } from './with-run-claim.js';
import type { Readable } from 'node:stream';

/**
 * What the death of the chain's own process does to the stage below it.
 *
 * This wrapper is the outermost process of the commands a developer runs, so it
 * is the one an operator finds and kills when one of them wedges — and a stage
 * holding no lifeline outlives exactly that kill. Only a real process can be
 * killed with a signal it cannot catch, so the cases below drive real ones: the
 * wrapper as it really runs, a leader under it, a supervisor under that, and a
 * task the supervisor put in a group of its own, which is the shape a task
 * runner gives everything it starts.
 *
 * Nothing in the tree binds a port, so nothing that reclaims from ports can be
 * what cleaned it up, and every claim here is a signal-zero probe against an id
 * this file watched being born.
 *
 * The stage below is reached the way every root script reaches one: through the
 * runner's command line, which forks, so the process that watches the lifeline
 * is not the process the wrapper spawned. A case that took that hop out would
 * prove the opposite of what it claims, so the case that kills asserts the hop
 * is there.
 *
 * The wrapper itself runs through tsx's loader in-process (`--import`) rather
 * than through its CLI: the process a case kills has to be the one answering
 * the socket, which in a real command it is.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
/** The runner's command line, which is the binary every root script names. */
const TSX_CLI = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const WRAPPER = fileURLToPath(new URL('with-run-claim.ts', import.meta.url));
const UNARMED_WRAPPER = fileURLToPath(new URL('unarmed-stage-entry.mjs', import.meta.url));
const LEADER_ENTRY = fileURLToPath(new URL('lib/spawn/lifeline-leader-entry.mjs', import.meta.url));
const PROBE_ENTRY = fileURLToPath(new URL('lib/spawn/lifeline-probe-entry.mjs', import.meta.url));

type WrapperProcess = ChildProcessByStdio<null, Readable, null>;

interface StartedChain {
  readonly wrapper: WrapperProcess;
  /** The stage's own parent, which is the process the runner's command line forked from. */
  readonly hop: number;
  /** The stage the wrapper started, which is where the lifeline is watched. */
  readonly leader: number;
  /** What the leader started, which is a supervisor of one task. */
  readonly supervisor: number;
  /** The supervisor's task, in a group of its own, which no group signal reaches. */
  readonly task: number;
}

let wrappers: WrapperProcess[];
let started: number[];
let scratchDir = '';
let claimDir = '';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function waitForExit(child: WrapperProcess): Promise<void> {
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

/** One id out of what a tree announced, refused unless it is one this file can watch. */
function announcedId(value: number | undefined, announced: string): number {
  if (value === undefined || !Number.isInteger(value) || value <= 1) {
    throw new Error(`The chain announced no id to watch. It said: ${announced}`);
  }
  return value;
}

/**
 * The environment every wrapper here runs under.
 *
 * The claim points at a directory of this case's own, so the wrapper adopts a
 * run instead of registering one in the machine-wide registry and records what
 * it starts where this file can remove it. The lifeline address is removed
 * rather than emptied: the value this process inherited names the chain hosting
 * these tests, and leaving it would make each wrapper a watcher of that chain
 * rather than the head of one of its own, which is what it is in a real
 * command. Emptied is not the same thing — an address that is present and empty
 * is a spawner that handed one over and lost it, which the mechanism refuses to
 * run on.
 */
function chainEnvironment(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => name !== LIFELINE_ENV);
  return {
    ...Object.fromEntries(inherited),
    [RUN_CLAIM_ENV]: claimDir,
    // Each chain answers on a socket under this case's own directory, so the
    // sockets of the processes it kills hard — which no runtime gets to clean
    // up after — go when that directory goes.
    TMPDIR: scratchDir,
  };
}

/**
 * Starts a chain of one stage and resolves once the tree below it has announced
 * itself. `detached` puts the wrapper in a group of its own, which is what lets
 * a case address either the wrapper alone or the group a terminal would signal.
 */
async function startChain(wrapperArgs: readonly string[]): Promise<StartedChain> {
  const reportDir = await fs.mkdtemp(path.join(scratchDir, 'chain-'));
  const wrapper = spawn(process.execPath, [...wrapperArgs, TSX_CLI, LEADER_ENTRY, reportDir], {
    env: chainEnvironment(),
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  wrappers.push(wrapper);

  // Every process names itself in a file rather than on its output: the stage's
  // output belongs to whatever the runner's command line does with it, and the
  // only way down to the supervisor's task is through a group that does not
  // contain it.
  const announced = await untilFileWritten(
    path.join(reportDir, 'leader'),
    CHAIN_ANNOUNCEMENT_BUDGET_MS
  );
  const ids = announced.split(' ').map(Number);
  const leader = announcedId(ids[0], announced);
  const hop = announcedId(ids[1], announced);
  const supervisor = announcedId(ids[2], announced);
  const task = announcedId(
    Number(await untilFileWritten(path.join(reportDir, 'task'), CHAIN_ANNOUNCEMENT_BUDGET_MS)),
    'task'
  );
  started.push(hop, leader, supervisor, task);

  return { wrapper, hop, leader, supervisor, task };
}

beforeEach(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-chain-lifeline-'));
  claimDir = path.join(scratchDir, 'run');
  await fs.mkdir(claimDir);
  wrappers = [];
  started = [];
  // Read empty so nothing a case spawns from this process records itself
  // against the claim of the run hosting these tests.
  vi.stubEnv(RUN_CLAIM_ENV, '');
});

/**
 * The socket this worker answers its children on goes when the file that made
 * it is done, rather than staying until the runner signals the worker — which
 * reaches no handler and would leave the file behind.
 */
afterAll(async () => {
  await closeProcessLifeline();
});

afterEach(async () => {
  // Ahead of the cleanup, because a cleanup that throws would otherwise skip it
  // and leave the worker without the claim this file was handed.
  vi.unstubAllEnvs();
  // Runs whether the case passed or failed, because a leak that only appears on
  // the unhappy path is the same leak. Every id here was watched being born by
  // this file, and each leads a group of its own.
  for (const pid of started) {
    if (Number.isInteger(pid) && pid > 1) killTree(pid, 'SIGKILL');
  }
  for (const wrapper of wrappers) {
    if (wrapper.pid !== undefined) killTree(wrapper.pid, 'SIGKILL');
    await waitForExit(wrapper);
  }
  await fs.rm(scratchDir, { recursive: true, force: true });
});

describe('a stage of the chain', () => {
  it('is handed an address this process is answering on', async () => {
    const report = path.join(scratchDir, 'probe');

    const code = await execStage({ file: process.execPath, args: [PROBE_ENTRY, report] });

    const reported = await fs.readFile(report, 'utf8');
    const [address, answer] = reported.split('\n');
    expect(code).toBe(0);
    expect(address).not.toBe('');
    expect(answer).toBe('answered');
  });
});

describe('a chain whose own process was killed hard', { timeout: CHAIN_CASE_TIMEOUT_MS }, () => {
  it('takes the stage with it, down to the task the supervisor moved out of reach', async () => {
    const chain = await startChain(['--import', TSX_LOADER, WRAPPER]);
    // The hop is what makes this the real chain: the stage's parent is the
    // runner's command line, not the wrapper that started it.
    expect(chain.hop).not.toBe(chain.wrapper.pid);
    expect(isAlive(chain.hop)).toBe(true);
    expect(isAlive(chain.leader)).toBe(true);
    expect(isAlive(chain.supervisor)).toBe(true);
    expect(isAlive(chain.task)).toBe(true);

    // The wrapper's own id and nothing else: a group signal would reach the
    // stage by itself and prove nothing about the lifeline.
    chain.wrapper.kill('SIGKILL');
    await waitForExit(chain.wrapper);

    expect(await untilSettled(() => !isAlive(chain.task))).toBe(true);
    expect(await untilSettled(() => !isAlive(chain.supervisor))).toBe(true);
    expect(await untilSettled(() => !isAlive(chain.leader))).toBe(true);
    expect(await untilSettled(() => !isAlive(chain.hop))).toBe(true);
  });
});

/**
 * The negative control, and the reason the case above is about the lifeline
 * rather than about anything else in the tree: the same four processes under a
 * starter that hands its stage nothing.
 *
 * Survival is asserted over a bounded settle rather than instantly, because
 * "nothing happened" cannot be observed as an event. What bounds it is
 * {@link SURVIVAL_WINDOW_MS}, which is longer than an armed teardown has been
 * observed taking, so a tree still standing at the end of it is one nothing
 * asked to go.
 */
describe(
  'the same tree under a starter that arms no lifeline',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    it('survives that starter being killed hard', async () => {
      const chain = await startChain([UNARMED_WRAPPER]);

      chain.wrapper.kill('SIGKILL');
      await waitForExit(chain.wrapper);

      expect(await untilObserved(() => !isAlive(chain.leader), SURVIVAL_WINDOW_MS)).toBe(false);
      expect(isAlive(chain.supervisor)).toBe(true);
      expect(isAlive(chain.task)).toBe(true);
    });
  }
);

/**
 * What a terminal does, reproduced: Ctrl+C delivers to the foreground process
 * group, and the wrapper leads a group of its own here, so signalling that
 * group is what a keypress does. The stage now sits in a group of its own, so
 * the signal reaches it only because the wrapper forwards it.
 */
describe(
  'a chain signalled the way a terminal signals one',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    const READY = 'ready';
    const TOOK = 'took';
    const STAGE_EXIT_CODE = 3;

    it('still reaches the stage, and still answers the code the stage exited with', async () => {
      const ready = path.join(scratchDir, READY);
      const took = path.join(scratchDir, TOOK);
      const wrapper = spawn(
        process.execPath,
        [
          '--import',
          TSX_LOADER,
          WRAPPER,
          process.execPath,
          '-e',
          `const fs = require('node:fs');
         const [ready, took] = process.argv.slice(1);
         process.on('SIGINT', () => {
           fs.writeFileSync(took, 'SIGINT');
           process.exit(${String(STAGE_EXIT_CODE)});
         });
         fs.writeFileSync(ready, 'ready');
         setInterval(() => {}, 60000);`,
          ready,
          took,
        ],
        { env: chainEnvironment(), stdio: ['ignore', 'pipe', 'inherit'], detached: true }
      );
      wrappers.push(wrapper);
      await untilFileWritten(ready, FIXTURE_BOOT_BUDGET_MS);

      if (wrapper.pid === undefined) throw new Error('The chain never started.');
      process.kill(-wrapper.pid, 'SIGINT');

      expect(await untilFileWritten(took, SIGNAL_REACTION_BUDGET_MS)).toBe('SIGINT');
      await waitForExit(wrapper);
      expect(wrapper.exitCode).toBe(STAGE_EXIT_CODE);
    });
  }
);
