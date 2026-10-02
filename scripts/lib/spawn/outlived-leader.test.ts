import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import {
  CHAIN_CASE_TIMEOUT_MS,
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  SURVIVAL_WINDOW_MS,
  untilFileWritten,
  untilObserved,
  untilSettled,
} from '../bounded-wait.setup.js';
import {
  LIFELINE_ENV,
  createTreeForwarder,
  endTrees,
  groupIsAlive,
  killTree,
  spawnLongLived,
  treeIsStanding,
  type TreeForwarder,
} from './long-lived.js';

/**
 * What a spawner owes a tree whose recorded leader is already gone.
 *
 * The case is not exotic; it is what every command here does. A spawn records
 * the process it started, that process forks the one doing the work into the
 * same group, and the fork outlives it whenever the leader is killed on its own
 * or exits first. A killed run then ends nothing: the record still names the
 * group, but the spawner had already stopped naming it the moment its own child
 * exited, so the group kept running with its suites to the end and nothing
 * above it ever asked it to stop.
 *
 * Driven with real processes and decided from kernel facts only — signal-zero
 * probes against ids this file watched being born, and a group probe against
 * the id the spawn recorded. Nothing here decides anything from a clock, and
 * nothing is addressed by a pattern.
 */
const FORKING_LEADER = fileURLToPath(new URL('forking-leader-entry.mjs', import.meta.url));

/** A parent that starts one child and then never runs another line, so it never collects it. */
const UNREAPING_PARENT = fileURLToPath(new URL('unreaping-parent-entry.mjs', import.meta.url));

/**
 * Where the run's own lifeline address travels, spelled the same way in
 * `lifeline-supervisor-entry.mjs`, which reads it. A name of its own because
 * the spawner overwrites the ordinary one at every hop: what a process deep in
 * a chain inherits there names the process directly above it.
 */
const RUN_LIFELINE_ENV = 'HB_SPAWN_RUN_LIFELINE';

let reportDir: string;
/** Every id this file watched being born, ended on the way out whatever happened. */
let watched: number[];
/**
 * Ids this file watched being born that lead no group of their own, ended as
 * the single processes they are. Kept apart from {@link watched} because a
 * tree kill negates the id, and negating one that leads nothing addresses
 * whichever unrelated group happens to answer to that number.
 */
let strays: number[];

/** Ends one process by an id this file watched being born, already-gone included. */
function end(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

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
 * A forwarder over a host nothing installs anything on, whose exit can be
 * delivered on demand.
 *
 * The exit rather than a signal, because the defect is reached by a spawner
 * that returned rather than by one that was asked to stop: a stage whose child
 * has exited is a stage the wrapper considers finished, and what runs then is
 * the exit handler.
 */
function drivenForwarder(): { readonly forwarder: TreeForwarder; deliverExit(): void } {
  const exits = new Set<() => void>();
  const forwarder = createTreeForwarder({
    on: () => {},
    off: () => {},
    onExit: (handler) => exits.add(handler),
    offExit: (handler) => exits.delete(handler),
    reraise: () => {},
  });
  return {
    forwarder,
    deliverExit: () => {
      for (const handler of exits) handler();
    },
  };
}

/**
 * The environment the tree runs under: this run's claim dropped so nothing the
 * tree starts is recorded against it, and this run's own lifeline address
 * carried down under a name no hop overwrites, which is what lets the fork end
 * with this run rather than standing on the machine if a case never gets to its
 * teardown.
 */
function treeEnvironment(): NodeJS.ProcessEnv {
  const run = process.env[LIFELINE_ENV];
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== RUN_CLAIM_ENV)),
    ...(run === undefined || run.length === 0 ? {} : { [RUN_LIFELINE_ENV]: run }),
    TMPDIR: reportDir,
  };
}

/** One id a fixture reported, refused unless it is one this file can watch. */
function reportedId(value: number | undefined, reported: string): number {
  if (value === undefined || !Number.isInteger(value) || value <= 1) {
    throw new Error(`The tree reported no id to watch. It said: ${reported}`);
  }
  return value;
}

interface StartedTree {
  /** The id the spawn recorded, which is the group's leader. */
  readonly pgid: number;
  /** The exit code once the recorded leader has gone. */
  readonly exit: Promise<number>;
  /** The leader's fork, in the leader's own group, which is what holds the work. */
  readonly worker: number;
  /** What the fork put in a group of its own, which no group signal here reaches. */
  readonly task: number;
}

async function startTree(forwarder: TreeForwarder): Promise<StartedTree> {
  const child = await spawnLongLived(process.execPath, [FORKING_LEADER, reportDir], {
    stdio: 'ignore',
    ports: [],
    forwarder,
    env: treeEnvironment(),
  });
  watched.push(child.pid);

  const reported = await untilFileWritten(path.join(reportDir, 'worker'), FIXTURE_BOOT_BUDGET_MS);
  const ids = reported.split(' ').map(Number);
  const worker = reportedId(ids[1], reported);
  watched.push(worker);
  const task = reportedId(
    Number(await untilFileWritten(path.join(reportDir, 'task'), FIXTURE_BOOT_BUDGET_MS)),
    'task'
  );
  watched.push(task);

  return { pgid: child.pgid, exit: child.exit, worker, task };
}

/**
 * Ends the recorded leader and nothing else, and waits until the spawn agrees
 * it has gone.
 *
 * Its own id rather than its group's: signalling the group would end the fork
 * by itself and prove nothing about what the spawner does afterwards.
 */
async function decapitate(tree: StartedTree): Promise<void> {
  process.kill(tree.pgid, 'SIGKILL');
  await tree.exit;
}

beforeEach(async () => {
  reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-outlived-leader-'));
  watched = [];
  strays = [];
});

afterEach(async () => {
  // Runs whether the case passed or failed, because a leak that only appears on
  // the unhappy path is the same leak. Every id here was watched being born by
  // this file, and each of these fixtures leads a group or sits in one.
  for (const pid of watched) {
    if (pid <= 1) continue;
    killTree(pid, 'SIGKILL');
    end(pid);
  }
  for (const pid of strays) end(pid);
  await fs.rm(reportDir, { recursive: true, force: true });
});

describe(
  'a tree whose recorded leader has gone while its group still holds processes',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    it('is ended when the process that started it goes', async () => {
      const host = drivenForwarder();
      const tree = await startTree(host.forwarder);
      expect(isAlive(tree.worker)).toBe(true);

      await decapitate(tree);

      // The state the defect lives in, asserted rather than assumed: the id the
      // spawn recorded names a group that still has members, and the work is
      // one of them.
      expect(groupIsAlive(tree.pgid)).toBe(true);
      expect(await untilObserved(() => !isAlive(tree.worker), SURVIVAL_WINDOW_MS)).toBe(false);

      host.deliverExit();

      expect(await untilSettled(() => !isAlive(tree.worker))).toBe(true);
    });

    it('ends the hop its fork recorded, not the fork that owns it', async () => {
      const host = drivenForwarder();
      const tree = await startTree(host.forwarder);

      await decapitate(tree);

      // The state the requirement is about: what the fork moved into a group of
      // its own is reachable through the fork and through nothing else, and an
      // uncatchable signal aimed at the group the fork sits in ends the fork
      // without the fork running a line.
      expect(isAlive(tree.task)).toBe(true);

      host.deliverExit();

      expect(await untilSettled(() => !isAlive(tree.task))).toBe(true);
    });

    it('takes the work with it when a teardown is told only that the leader exited', async () => {
      const host = drivenForwarder();
      const tree = await startTree(host.forwarder);

      await decapitate(tree);

      // Its own grace, because what is under test is whether the ask lands
      // before the escalation does: a teardown handed none would escalate onto
      // the group in the same tick it asked it, and pass with the ask removed.
      await endTrees([{ pid: tree.pgid, exit: tree.exit }]);

      expect(await untilSettled(() => !isAlive(tree.worker))).toBe(true);
      // The escaped task with it, which a teardown reaches only by asking: the
      // fork is the sole thing that can end what it moved into a group of its
      // own, and asking the dead leader would have asked nobody.
      expect(await untilSettled(() => !isAlive(tree.task))).toBe(true);
    });

    it('is left alone by a teardown that runs again once it has gone', async () => {
      const host = drivenForwarder();
      const tree = await startTree(host.forwarder);
      await decapitate(tree);
      await endTrees([{ pid: tree.pgid, exit: tree.exit }]);
      expect(await untilSettled(() => !groupIsAlive(tree.pgid))).toBe(true);

      // Nothing is in the group any more, so the id it was addressed by is the
      // kernel's to hand to unrelated work. A second teardown must therefore
      // reach nothing at all rather than signalling that number again.
      await endTrees([{ pid: tree.pgid, exit: tree.exit }]);

      expect(groupIsAlive(tree.pgid)).toBe(false);
    });
  }
);

/**
 * What a group answers once the only thing left in it is a child nobody
 * collected.
 *
 * This is the state every exit here ends in, not an exotic one. A process on
 * its way out asks the tree it started to stop and then waits for the group to
 * empty, and the child it asked is its own: the death is delivered to a loop
 * that has already closed, so the corpse stays in the group for as long as the
 * exiting process is there. A reading that counts members can therefore never
 * observe that drain, and the wait it bounds is spent in full on a tree that
 * went at once.
 *
 * Driven with real processes, and every id here was watched being born by this
 * file.
 */
describe(
  'a recorded group holding nothing but a child that was never collected',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    it('answers that the tree has gone', async () => {
      // Twice the one wait this case makes while the fixture holds. If the
      // fixture goes first the corpse is collected with it, and the last
      // assertion fails rather than the case passing on a group that emptied
      // for a reason that has nothing to do with the subject.
      const hold = SIGNAL_REACTION_BUDGET_MS * 2;
      const parent = spawn(process.execPath, [UNREAPING_PARENT, reportDir, String(hold)], {
        stdio: 'ignore',
        detached: true,
      });
      watched.push(reportedId(parent.pid, 'parent'));

      const child = reportedId(
        Number(await untilFileWritten(path.join(reportDir, 'unreaped'), FIXTURE_BOOT_BUDGET_MS)),
        'unreaped'
      );
      watched.push(child);
      // The reading answers that this tree is standing while it is, so the
      // answer it gives after the kill is a fact about the group rather than
      // about an instrument that answers the same thing to everything.
      expect(treeIsStanding(child, 'linux')).toBe(true);

      process.kill(child, 'SIGKILL');

      expect(
        await untilObserved(() => !treeIsStanding(child, 'linux'), SIGNAL_REACTION_BUDGET_MS)
      ).toBe(true);
      // The state the finding lives in, asserted rather than assumed: the id
      // still answers that its group has members, because a corpse is one.
      expect(groupIsAlive(child)).toBe(true);
    });
  }
);

/**
 * A live process that leads no group is the shape a record takes once the group
 * it named has emptied and the kernel has handed the number on. A teardown that
 * reads the two in the wrong order — the process first, the group second —
 * cannot tell that case from a tree of its own, and signals whatever holds the
 * number now.
 */
describe('a teardown given an id that leads no group', { timeout: CHAIN_CASE_TIMEOUT_MS }, () => {
  it('leaves the process holding that id alone', async () => {
    // Not detached, so it joins this process's group rather than leading one:
    // the id is a live process and names no tree, which is exactly what a
    // record outliving its group resolves to.
    const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: 'ignore',
      detached: false,
    });
    const pid = reportedId(stray.pid, 'stray');
    strays.push(pid);
    expect(await untilObserved(() => isAlive(pid), FIXTURE_BOOT_BUDGET_MS)).toBe(true);
    expect(groupIsAlive(pid)).toBe(false);

    await endTrees([{ pid, exit: Promise.resolve(0) }]);

    expect(await untilObserved(() => !isAlive(pid), SURVIVAL_WINDOW_MS)).toBe(false);
  });
});
