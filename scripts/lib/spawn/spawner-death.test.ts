import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import {
  LIFELINE_ENV,
  killTree,
  scanLifelineSockets,
  withoutInheritedIdentity,
} from './long-lived.js';
import {
  CHAIN_CASE_TIMEOUT_MS,
  SURVIVAL_WINDOW_MS,
  untilObserved,
  untilSettled,
} from '../bounded-wait.setup.js';

/**
 * What a leader does when the process that started it dies — proven through the
 * chains this repository's commands actually use, with real processes, one of
 * them killed with a signal it cannot catch, and no port anywhere in the tree.
 *
 * **The hops are the subject.** Every command here reaches the code that
 * watches a lifeline through at least one process that runs none of it: the
 * runner's command line, which forks, and the package manager, which puts its
 * own process and a shell in the way. A mechanism that is handed down rather
 * than published dies at the first of those, and a case that took the hop out
 * to make its assertion pass would prove the opposite of what it claims. So
 * each case asserts the hop is there — the leader's parent is not the process
 * that started the chain — before it asserts anything about the kill.
 *
 * The tree below the hop is the shape the incident had. The leader's own child
 * is a supervisor, and the supervisor's task sits in a process group of its own
 * — as every task a task runner starts does — so no group the leader could
 * signal reaches that task. It is reached only because the supervisor is asked
 * to stop and cleans up after itself, which is the whole reason the teardown
 * asks before it signals.
 *
 * No listener, deliberately. A tree that held one would also be reachable by
 * the reclaimer that works from ports, and a case whose subject could have been
 * cleaned up by something else proves nothing about the thing under test. That
 * leaves the process ids as the only handles, so every claim here is a
 * signal-zero probe against an id this file watched being born.
 *
 * The one process that is *not* reached through a hop is the chain's own top,
 * which runs through the runner's loader in-process (`--import`) rather than
 * through its command line: the process a case kills has to be the one
 * answering the socket, exactly as it is in the wrappers this stands in for.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
/** The runner's command line, which is the binary every root script names. */
const TSX_CLI = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
const SPAWNER_ENTRY = fileURLToPath(new URL('lifeline-spawner-entry.mjs', import.meta.url));
const UNARMED_ENTRY = fileURLToPath(new URL('lifeline-unarmed-spawner-entry.mjs', import.meta.url));
const LEADER_ENTRY = fileURLToPath(new URL('lifeline-leader-entry.mjs', import.meta.url));
const HANDOFF_ENTRY = fileURLToPath(new URL('lifeline-handoff-entry.mjs', import.meta.url));
const IDLE_CHILD_ENTRY = fileURLToPath(new URL('idle-child-entry.mjs', import.meta.url));

/** The one script of the scratch package, which is how the package manager is reached. */
const SCRATCH_SCRIPT = 'leader';

interface StartedChain {
  readonly starter: ChildProcess;
  /** What the starter spawned, which is the hop rather than the leader. */
  readonly spawned: number;
  /** The leader's own parent, which is the process the hop put in between. */
  readonly hop: number;
  /** The process that watches the lifeline and holds a tree of its own. */
  readonly leader: number;
  /** What the leader started, which is a supervisor of one task. */
  readonly supervisor: number;
  /** The supervisor's task, in a group of its own, which no group signal reaches. */
  readonly task: number;
}

let starters: ChildProcess[];
let started: number[];
let reportDir: string;
let scratchPackage: string;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * How the idle child is run: through the runner's loader, because it imports
 * the spawner's module, which is what arms it against the process that started
 * it. A child written on the runner's own command line instead runs none of
 * that module, watches nothing, and stands on the machine for good once the run
 * that started it is killed.
 */
function idleChild(): readonly string[] {
  return [process.execPath, '--import', TSX_LOADER, IDLE_CHILD_ENTRY];
}

/**
 * Reads what a chain reported of itself, ending on the report or on the death
 * of the process that produces it.
 *
 * Never on a count of attempts, which is the instrument this replaced and which
 * bounded nothing: the reads between the sleeps are unbounded, so a count
 * prices sleeping time only and the same number spends wildly different amounts
 * of waiting as the host gets busier. Instrumented over three runs, one read
 * here consumed 375 of the 400 attempts it was given against a mean of 54, and
 * a later run measured that same read taking 31.4 seconds while every other one
 * finished inside 1.1. Enlarging the count buys a proportionally larger floor
 * and no more coverage of the boot it has to cover.
 *
 * What ends it instead is observed. A chain is five processes deep behind
 * `producer`, so while `producer` is alive the report is still on its way, and
 * the only other outcome is that the top of the chain — which is what starts
 * everything that writes here, and what an armed chain's whole tree watches —
 * is gone. {@link CHAIN_CASE_TIMEOUT_MS} is the whole bound on the waiting,
 * and nothing here decides anything from a clock.
 *
 * Liveness is read before the report and never after, so a top that wrote what
 * a case wanted and then exited — which is exactly what a top with nothing to
 * hold it open does — is still read as having written it.
 */
async function untilNamed(
  producer: ChildProcess,
  file: string,
  dir: string = reportDir
): Promise<string> {
  for (;;) {
    const gone = producer.exitCode !== null || producer.signalCode !== null;
    const seen = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
    if (seen.length > 0) return seen;
    if (gone) {
      throw new Error(
        `The top of the chain ended before anything was written to its \`${file}\` report.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
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
 * Ends one process and the group it leads, tolerating either being gone.
 *
 * Both, because a chain here holds two kinds of process: the ones the spawner
 * started, which lead groups of their own, and the ones a hop forked, which do
 * not. Whichever it is, the id was watched being born by this file.
 */
function endWhatever(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  killTree(pid, 'SIGKILL');
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** One id out of what a chain reported, refused unless it is one this file can watch. */
function reportedId(value: number | undefined, reported: string): number {
  if (value === undefined || !Number.isInteger(value) || value <= 1) {
    throw new Error(`The chain reported no id to watch. It said: ${reported}`);
  }
  return value;
}

/**
 * Where the run's own lifeline address travels down a chain, spelled the same
 * way in `lifeline-supervisor-entry.mjs`, which reads it. A name of its own
 * because `spawnLongLived` overwrites the ordinary one at every hop: what a
 * process deep in a chain inherits there is the one directly above it.
 */
const RUN_LIFELINE_ENV = 'HB_SPAWN_RUN_LIFELINE';

/**
 * The environment every chain here runs under.
 *
 * The run claim is removed rather than emptied: it is the one this test run
 * holds, and a chain inheriting it would record what it starts where a
 * reclaimer answering to that run would later find it.
 *
 * The lifeline address is kept, and keeping it is the whole of what arms a
 * chain started by a bare spawn. `long-lived.ts`'s `spawnLongLived` states its
 * own address for every child it starts, so the inherited one reaches the top
 * of a chain and nothing below it: what the top watches is the run, and what
 * every process under it watches is the one directly above. Dropping it left
 * these chains watching nothing — named by no claim, so reachable by no
 * reclaimer, and standing on the machine for good once the run that started
 * them was killed.
 *
 * That leaves one process the chain's own watches cannot cover, and it is why
 * the same address also goes down under a second name: a supervisor is reached
 * only by the leader asking it to stop, so a leader killed too hard to ask
 * anything strands it. Read at call time, so a chain started under a stand-in
 * run gets that run's address rather than this process's, and absent rather
 * than empty when there is none — an address that names nothing is what the
 * watcher refuses to run on.
 */
function chainEnvironment(): NodeJS.ProcessEnv {
  const run = process.env[LIFELINE_ENV];
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== RUN_CLAIM_ENV)),
    ...(run === undefined || run.length === 0 ? {} : { [RUN_LIFELINE_ENV]: run }),
    // Each chain answers on a socket under a directory of its own, so the
    // sockets of the processes these cases kill hard — which no runtime gets to
    // clean up after — go when the case's directory goes.
    TMPDIR: reportDir,
  };
}

/**
 * Starts a chain and resolves once the tree under it has reported itself.
 *
 * `starterArgs` is how the chain's top is run, and `childArgs` is the command
 * it starts — which is where a case chooses the hops it wants proven.
 */
async function startChain(
  starterArgs: readonly string[],
  childArgs: readonly string[]
): Promise<StartedChain> {
  const starter = spawn(process.execPath, [...starterArgs, reportDir, ...childArgs], {
    env: chainEnvironment(),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  starters.push(starter);

  // Registered one at a time, as each is read. Every read here is a bounded
  // wait that throws when it runs out, and a chain is already running by then:
  // registering the lot after the last read would hand the teardown an empty
  // list on exactly the runs where a process was left standing.
  const spawned = reportedId(Number(await untilNamed(starter, 'spawned')), 'spawned');
  started.push(spawned);
  const reported = await untilNamed(starter, 'leader');
  const ids = reported.split(' ').map(Number);
  const leader = reportedId(ids[0], reported);
  const hop = reportedId(ids[1], reported);
  const supervisor = reportedId(ids[2], reported);
  started.push(hop, leader, supervisor);
  const task = reportedId(Number(await untilNamed(starter, 'task')), 'task');
  started.push(task);

  return { starter, spawned, hop, leader, supervisor, task };
}

/**
 * How the negative control's own top is run: through the runner's loader,
 * because it imports the spawner's module to watch the address it inherits.
 *
 * Watching costs the control nothing. It publishes no address of its own, so
 * what it starts still watches the run rather than this process, and killing it
 * still leaves that chain standing — which is the whole of what this controls
 * for. What the watch adds is the property every other fixture here has: the
 * control goes when the run that started it does, instead of standing on the
 * machine once that run is killed.
 */
function unarmedStarter(): readonly string[] {
  return ['--import', TSX_LOADER, UNARMED_ENTRY];
}

/** Runs the leader through the runner's command line, which forks. */
function throughTheRunner(): readonly string[] {
  return [TSX_CLI, LEADER_ENTRY, reportDir];
}

/** Runs the leader through the package manager, which puts a shell in the way too. */
function throughThePackageManager(): readonly string[] {
  return ['pnpm', '--dir', scratchPackage, 'run', '--silent', SCRATCH_SCRIPT];
}

/** Every process of a chain, from the one the starter spawned down to the escaped task. */
function wholeTree(chain: StartedChain): readonly number[] {
  return [chain.spawned, chain.hop, chain.leader, chain.supervisor, chain.task];
}

interface StandInRun {
  /** The process a case kills, standing in for the run this file is running under. */
  readonly host: ChildProcess;
  /** The socket it answers on, which is the address a chain started under it inherits. */
  readonly address: string;
}

/**
 * A real process answering a lifeline socket, standing in for this run.
 *
 * A case cannot kill the run it is running inside, so it kills one of these
 * instead: the same mechanism one process down, and a real kill rather than a
 * stand-in for one. It is the head of its own chain — neither identity of this
 * run reaches it — and it answers on a socket because it started a child
 * through the spawner, which is what opens one. Its own directory is what makes
 * that socket the only one a scan of the directory finds.
 */
async function startStandInRun(): Promise<StandInRun> {
  const dir = path.join(reportDir, 'run');
  await fs.mkdir(dir);
  const host = spawn(
    process.execPath,
    ['--import', TSX_LOADER, SPAWNER_ENTRY, dir, ...idleChild()],
    {
      env: { ...withoutInheritedIdentity(process.env), TMPDIR: dir },
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  );
  starters.push(host);
  // Named once the child is running, which is after the socket is accepting: a
  // chain that connected between the bind and the listen would be refused and
  // would take itself down on the spot.
  started.push(reportedId(Number(await untilNamed(host, 'spawned', dir)), 'spawned'));

  const [address] = await scanLifelineSockets(dir);
  if (address === undefined) {
    throw new Error('The stand-in run started a child while answering on no socket of its own.');
  }
  return { host, address };
}

/**
 * Starts a chain with the address it inherits naming `address` rather than
 * whatever this process was started under, and puts back what was there.
 *
 * Restored by removing rather than emptying where there was nothing, because an
 * address that is present and names nothing is a spawner that handed one over
 * and lost it, which the mechanism refuses to run on.
 */
function underRun<T>(address: string, start: () => T): T {
  const inherited = process.env[LIFELINE_ENV];
  process.env[LIFELINE_ENV] = address;
  try {
    return start();
  } finally {
    if (inherited === undefined) Reflect.deleteProperty(process.env, LIFELINE_ENV);
    else process.env[LIFELINE_ENV] = inherited;
  }
}

beforeEach(async () => {
  reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-spawner-death-'));
  // A package of its own, because the package manager's hop is reached by
  // asking it to run a script and there is no root script that runs a fixture.
  scratchPackage = path.join(reportDir, 'package');
  await fs.mkdir(scratchPackage);
  await fs.writeFile(
    path.join(scratchPackage, 'package.json'),
    JSON.stringify({
      name: 'hb-lifeline-chain',
      private: true,
      scripts: { [SCRATCH_SCRIPT]: `"${TSX_CLI}" "${LEADER_ENTRY}" "${reportDir}"` },
    })
  );
  starters = [];
  started = [];
});

afterEach(async () => {
  // Runs whether the case passed or failed, because a leak that only appears on
  // the unhappy path is the same leak. Every id here was watched being born by
  // this file, and the chain puts each of them in a group of its own.
  for (const pid of started) endWhatever(pid);
  for (const starter of starters) {
    starter.kill('SIGKILL');
    await waitForExit(starter);
  }
  await fs.rm(reportDir, { recursive: true, force: true });
});

describe(
  'a chain reached through the runner command line',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    it('goes entirely, every hop of it, when the process that started it is killed hard', async () => {
      const chain = await startChain(['--import', TSX_LOADER, SPAWNER_ENTRY], throughTheRunner());
      // The hop is what this case exists for: the leader's parent is the runner's
      // command line, not the process that started the chain.
      expect(chain.hop).not.toBe(chain.starter.pid);
      for (const pid of wholeTree(chain)) expect(isAlive(pid)).toBe(true);

      // The starter's own id and nothing else: a group signal would reach the
      // chain by itself and prove nothing about the lifeline.
      chain.starter.kill('SIGKILL');
      await waitForExit(chain.starter);

      for (const pid of wholeTree(chain))
        expect(await untilSettled(() => !isAlive(pid))).toBe(true);
    });
  }
);

describe('a chain reached through the package manager', { timeout: CHAIN_CASE_TIMEOUT_MS }, () => {
  it('goes entirely, every hop of it, when the process that started it is killed hard', async () => {
    const chain = await startChain(
      ['--import', TSX_LOADER, SPAWNER_ENTRY],
      throughThePackageManager()
    );
    // Two processes in between here rather than one: what the starter spawned
    // is the package manager, and what fathered the leader is the runner's
    // command line it eventually reached.
    expect(chain.hop).not.toBe(chain.starter.pid);
    expect(chain.hop).not.toBe(chain.spawned);
    for (const pid of wholeTree(chain)) expect(isAlive(pid)).toBe(true);

    chain.starter.kill('SIGKILL');
    await waitForExit(chain.starter);

    for (const pid of wholeTree(chain)) expect(await untilSettled(() => !isAlive(pid))).toBe(true);
  });
});

/**
 * The negative control, and the reason the cases above are about the lifeline
 * rather than about anything else in the chain: the same processes, over the
 * same hops, under a starter that publishes no address.
 *
 * Survival is asserted over a bounded settle rather than instantly, because
 * "nothing happened" cannot be observed as an event. What bounds it is
 * {@link SURVIVAL_WINDOW_MS}, which is longer than an armed teardown has been
 * observed taking, so a chain still standing at the end of it is one nothing
 * asked to go.
 */
describe(
  'the same chain under a starter that publishes no address',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    it('survives that starter being killed hard', async () => {
      const chain = await startChain(unarmedStarter(), throughThePackageManager());

      chain.starter.kill('SIGKILL');
      await waitForExit(chain.starter);

      expect(await untilObserved(() => !isAlive(chain.leader), SURVIVAL_WINDOW_MS)).toBe(false);
      expect(isAlive(chain.supervisor)).toBe(true);
      expect(isAlive(chain.task)).toBe(true);
    });

    it('goes entirely, its own starter included, when the run that started it is killed hard', async () => {
      const run = await startStandInRun();
      const chain = await underRun(run.address, () =>
        startChain(unarmedStarter(), throughThePackageManager())
      );
      // The control's own property first, under the run this case will kill:
      // nothing in this chain is watching the starter, so what goes below is the
      // run going and never the starter having gone.
      for (const pid of wholeTree(chain)) expect(isAlive(pid)).toBe(true);

      // The run's own process and nothing else: a signal aimed at its group would
      // reach the chain by itself and prove nothing about the watch.
      run.host.kill('SIGKILL');
      await waitForExit(run.host);

      for (const pid of wholeTree(chain))
        expect(await untilSettled(() => !isAlive(pid))).toBe(true);
      expect(await untilSettled(() => chain.starter.exitCode !== null)).toBe(true);
    });
  }
);

/**
 * What a leader killed too hard to run any code leaves below it, which is the
 * residual the lifeline module states it cannot close on its own: a supervisor
 * nothing above it can ask to stop any more, holding a task in a process group
 * no signal aimed at this chain reaches.
 *
 * The supervisor watches the run rather than the leader, and the difference is
 * the whole case. Watching the leader would end this fixture for the same
 * reason the armed cases already end it, and those cases would then pass with
 * the ask-then-signal path removed — the one thing they exist to prove.
 */
describe(
  'a chain whose leader was killed too hard to be asked anything',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    it('leaves a supervisor that goes with the run, taking its escaped task with it', async () => {
      const run = await startStandInRun();
      const chain = await underRun(run.address, () =>
        startChain(['--import', TSX_LOADER, SPAWNER_ENTRY], throughTheRunner())
      );

      // The leader's own id and nothing else. It runs no code, so nothing it
      // holds is asked to stop, and its own group holds neither the supervisor
      // nor the task — both were detached into groups of their own.
      process.kill(chain.leader, 'SIGKILL');
      expect(await untilSettled(() => !isAlive(chain.leader))).toBe(true);
      // Still standing after a settle, so what takes them below is the run going
      // and not the leader having gone a moment earlier.
      expect(await untilObserved(() => !isAlive(chain.supervisor), SURVIVAL_WINDOW_MS)).toBe(false);
      expect(isAlive(chain.task)).toBe(true);

      // The run's own id and nothing else. Nothing still standing was signalled
      // here at all, so what ends the supervisor can only be the watch it holds
      // on the run, and what ends the task can only be the supervisor.
      run.host.kill('SIGKILL');
      await waitForExit(run.host);

      for (const pid of [chain.supervisor, chain.task]) {
        expect(await untilSettled(() => !isAlive(pid))).toBe(true);
      }
    });
  }
);

describe('a chain whose top was asked to stop', { timeout: CHAIN_CASE_TIMEOUT_MS }, () => {
  it('takes the whole chain with it, exactly as it did before there was a lifeline', async () => {
    const chain = await startChain(['--import', TSX_LOADER, SPAWNER_ENTRY], throughTheRunner());

    chain.starter.kill('SIGINT');
    await waitForExit(chain.starter);

    for (const pid of wholeTree(chain)) expect(await untilSettled(() => !isAlive(pid))).toBe(true);
  });
});

/**
 * What a process that exits at once leaves behind, which is where the mechanism
 * this replaced could not go. A descriptor would have gone with that process;
 * an address travels down the environment and outlives it, so what it left is
 * still watching the top of the chain two hops above.
 */
describe(
  'a process the chain started that exits at once',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    /** Starts the chain's top over a child that leaves `left` behind and exits. */
    function startHandoff(hold: readonly string[], left: readonly string[]): ChildProcess {
      const starter = spawn(
        process.execPath,
        [
          '--import',
          TSX_LOADER,
          SPAWNER_ENTRY,
          reportDir,
          ...hold,
          process.execPath,
          HANDOFF_ENTRY,
          reportDir,
          ...left,
        ],
        { env: chainEnvironment(), stdio: ['ignore', 'inherit', 'inherit'] }
      );
      starters.push(starter);
      return starter;
    }

    it('never holds the top of the chain open, whatever it left still running', async () => {
      // What it leaves is watching the top of the chain, and that is what makes
      // the exit below an exit that was not waited on rather than an ordinary
      // one: a top that waited on what its child left behind would wait on a
      // process waiting on it, and neither would ever end.
      const starter = startHandoff([], idleChild());

      started.push(reportedId(Number(await untilNamed(starter, 'handoff')), 'handoff'));
      await waitForExit(starter);

      expect(starter.exitCode).toBe(0);
    });

    it('leaves a child that goes when the run that started the chain is killed hard', async () => {
      const run = await startStandInRun();
      // Held open once its own child has exited, so what ends the child it left
      // behind is the run going and nothing the chain did on its way out.
      const starter = underRun(run.address, () => startHandoff(['--hold'], idleChild()));

      const left = reportedId(Number(await untilNamed(starter, 'handoff')), 'handoff');
      started.push(left);
      // Nothing above it has gone yet, so a child that ended here ended of its
      // own accord and the kill below would prove nothing about what took it.
      expect(await untilObserved(() => !isAlive(left), SURVIVAL_WINDOW_MS)).toBe(false);

      // The run's own process and nothing else: a signal aimed at its group would
      // reach the chain by itself and prove nothing about the watch.
      run.host.kill('SIGKILL');
      await waitForExit(run.host);

      expect(await untilSettled(() => !isAlive(left))).toBe(true);
    });

    it('leaves a leader that goes with the top of the chain, which never saw it start', async () => {
      const starter = startHandoff(['--hold'], [TSX_CLI, LEADER_ENTRY, reportDir]);

      const reported = await untilNamed(starter, 'leader');
      const ids = reported.split(' ').map(Number);
      const leader = reportedId(ids[0], reported);
      const supervisor = reportedId(ids[2], reported);
      started.push(leader, supervisor);
      const task = reportedId(Number(await untilNamed(starter, 'task')), 'task');
      started.push(task);
      const handoff = reportedId(Number(await untilNamed(starter, 'spawned')), 'spawned');
      // The process in between has gone while what it started is still running:
      // exactly the pair of facts a descriptor could not have produced together.
      expect(await untilSettled(() => !isAlive(handoff))).toBe(true);
      for (const pid of [leader, supervisor, task]) expect(isAlive(pid)).toBe(true);

      starter.kill('SIGKILL');
      await waitForExit(starter);

      for (const pid of [leader, supervisor, task]) {
        expect(await untilSettled(() => !isAlive(pid))).toBe(true);
      }
    });
  }
);
