import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, connect } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RUN_CLAIM_ENV,
  addSpawnedProcess,
  enumerateClaims,
  registerRun,
} from '../claims/registry.js';
import {
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  SURVIVAL_WINDOW_MS,
  untilFileWritten,
  untilObserved,
  untilSettled,
} from '../bounded-wait.setup.js';
import {
  LIFELINE_ENV,
  closeProcessLifeline,
  createTreeForwarder,
  endTrees,
  spawnLongLived,
  type LongLivedChild,
  type TreeForwarder,
  type TreeSignal,
} from './long-lived.js';

const PORT_HOLDER = fileURLToPath(new URL('port-holder-entry.mjs', import.meta.url));
const LIFELINE_PROBE = fileURLToPath(new URL('lifeline-probe-entry.mjs', import.meta.url));
const LIFELINE_HANDOFF = fileURLToPath(new URL('lifeline-handoff-entry.mjs', import.meta.url));
const LIFELINE_SPAWNER = fileURLToPath(new URL('lifeline-spawner-entry.mjs', import.meta.url));
/** The runner's loader, imported in-process so a signal reaches the process that answers. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const IDLE_CHILD = fileURLToPath(new URL('idle-child-entry.mjs', import.meta.url));

/**
 * The environment a chain of its own runs under: this process's claim dropped
 * so the chain is not taken for part of the run under test, and a temporary
 * directory of its own so the socket of a process killed too hard to remove it
 * goes when the chain's directory goes.
 *
 * The address this run is watched on is kept, and that is the whole of what
 * arms a chain started by a bare spawn: {@link spawnLongLived} replaces it for
 * every child it starts with the address of the process starting it, so what a
 * chain begun here watches is the run, and what everything below it watches is
 * the process directly above. Dropping it left a chain nothing could reach —
 * unwatched, named by no claim, and standing on the machine for good once the
 * run that started it was killed.
 */
function chainEnvironment(chain: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== RUN_CLAIM_ENV)),
    TMPDIR: chain,
  };
}

/**
 * How the idle child is run: through the runner's loader, because it imports
 * the spawner's module — which is what arms it against the process that started
 * it. `deaf` makes it ignore being asked to stop.
 */
function idleChild(options: { readonly deaf?: boolean } = {}): string[] {
  return ['--import', TSX_LOADER, IDLE_CHILD, ...(options.deaf === true ? ['--deaf'] : [])];
}

/**
 * How the port holder is run here: armed, and therefore through the runner's
 * loader, because arming it imports the spawner's module.
 *
 * Arming is the caller's to ask for rather than the fixture's to assume,
 * because the run that starts it is the same run whose death this file's cases
 * are about: a copy started by this worker has to go when the worker does,
 * while the copy a real run starts has to outlive that run, which is what the
 * orphan-reclaim cases assert on. So the flag travels with the call site, and
 * the call sites that want survival never pass it.
 */
function portHolder(ports: readonly number[], options: { readonly deaf?: boolean } = {}): string[] {
  return [
    '--import',
    TSX_LOADER,
    PORT_HOLDER,
    ...ports.map(String),
    '--watch-spawner',
    ...(options.deaf === true ? ['--deaf'] : []),
  ];
}

/** What a chain wrote into its report directory, once it has written it. */
function untilNamed(chain: string, file: string): Promise<string> {
  return untilFileWritten(path.join(chain, file), FIXTURE_BOOT_BUDGET_MS);
}

/** Waits for a socket file to go, which a close does on a turn of its own. */
async function untilGone(address: string): Promise<boolean> {
  return untilObserved(async () => {
    try {
      await fs.stat(address);
      return false;
    } catch {
      return true;
    }
  }, SIGNAL_REACTION_BUDGET_MS);
}

/** A forwarder that watches nothing, so a test never installs handlers on the vitest process. */
const detachedForwarder: TreeForwarder = {
  add: () => (): void => {},
};

let registryDir: string;
let started: LongLivedChild[];
let inheritedRunClaim: string | undefined;

/** A port nothing holds right now. Bound and released, so the answer is the kernel's. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
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

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startPortHolder(
  ports: readonly number[],
  options: { readonly forwarder?: TreeForwarder; readonly claimed?: readonly number[] } = {}
): Promise<LongLivedChild> {
  const child = await spawnLongLived(process.execPath, portHolder(ports), {
    stdio: 'ignore',
    forwarder: options.forwarder ?? detachedForwarder,
    ports: options.claimed ?? [],
  });
  started.push(child);
  return child;
}

/** A child that holds nothing and ends only when it is killed, spawned for a named platform. */
function startIdleChild(platform: NodeJS.Platform): Promise<LongLivedChild> {
  return spawnLongLived(process.execPath, idleChild(), {
    stdio: 'ignore',
    forwarder: detachedForwarder,
    ports: [],
    platform,
  });
}

/**
 * Ends one by pid rather than through its handle: the handle kills for the
 * platform it was given, and the win32 side of that reaches for a command this
 * host does not have.
 */
async function endIdleChild(child: LongLivedChild): Promise<void> {
  process.kill(child.pid, 'SIGKILL');
  await child.exit;
}

beforeEach(async () => {
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-long-lived-'));
  started = [];
  inheritedRunClaim = process.env[RUN_CLAIM_ENV];
  process.env[RUN_CLAIM_ENV] = '';
});

afterEach(async () => {
  // Ahead of the cleanup, because a cleanup that throws would otherwise skip it
  // and leave the worker without the claim this file was handed. The empty
  // string rather than removal: every reader treats an empty claim variable as
  // no claim, and a computed key cannot be deleted.
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  for (const child of started) await child.kill('SIGKILL');
  await fs.rm(registryDir, { recursive: true, force: true });
});

function run<T>(body: () => Promise<T>): Promise<T> {
  return registerRun(
    {
      command: 'pnpm dev',
      mode: 'development',
      slot: 0,
      gitCommonDir: path.join(registryDir, 'checkout', '.git'),
      registryDir,
    },
    body
  );
}

/**
 * The socket this worker answers its children on goes when the file that made
 * it is done, rather than staying until the runner signals the worker — which
 * reaches no handler and would leave the file behind.
 */
afterAll(async () => {
  await closeProcessLifeline();
});

describe('spawnLongLived', () => {
  it('records the tree against the run before the caller waits for readiness', async () => {
    const port = await freePort();

    await run(async () => {
      const child = await startPortHolder([port]);

      const [found] = await enumerateClaims(registryDir);
      expect(found?.claim.spawned).toEqual([{ pid: child.pid, pgid: child.pgid }]);
      // The claim already names the tree while the port is still silent, which
      // is the window a killed run would otherwise leave nothing behind for.
      expect(await isListening(port)).toBe(false);
    });
  });

  it('records the ports its tree is expected to bind, before the child that binds them', async () => {
    const port = await freePort();

    await run(async () => {
      await startPortHolder([port], { claimed: [port] });

      // The port is the handle that survives the tree escaping the group the
      // claim names, which is what a supervisor putting its tasks in a second
      // group does to every recorded pgid.
      const [found] = await enumerateClaims(registryDir);
      expect(found?.claim.resources).toContainEqual({ kind: 'port', id: String(port) });
      expect(await isListening(port)).toBe(false);
    });
  });

  it('records the ports of a child that never started, claiming before anything is created', async () => {
    const port = await freePort();

    await run(async () => {
      await expect(
        spawnLongLived('hushbox-no-such-executable', [], {
          stdio: 'ignore',
          forwarder: detachedForwarder,
          ports: [port],
        })
      ).rejects.toThrow(/did not start/);

      // A claim naming a port nothing ever bound is harmless; the reverse order
      // produces an orphan nothing names.
      const [found] = await enumerateClaims(registryDir);
      expect(found?.claim.resources).toContainEqual({ kind: 'port', id: String(port) });
    });
  });

  it('records no port for a process holding no run claim', async () => {
    const port = await freePort();

    await startPortHolder([port], { claimed: [port] });

    expect(await enumerateClaims(registryDir)).toEqual([]);
  });

  it('addresses the tree by a group id a reclaimer can use', async () => {
    const port = await freePort();

    await run(async () => {
      const child = await startPortHolder([port]);
      expect(child.pgid).toBe(child.pid);
    });
  });

  // The cases that inject a platform through {@link startIdleChild} drive both
  // sides of the `detached` branch on the one host every case here runs on.
  // They prove which side the branch selected — nothing about how Windows or
  // macOS behave, which no test here can reach. What each side decides is
  // whether the child leads a process group of its own, and a group signal is
  // the kernel's answer to that: a group whose id is the child's pid exists
  // only if the child leads it.
  it('makes a child the leader of its own group when the platform is not win32', async () => {
    const child = await startIdleChild('linux');

    try {
      expect(() => {
        process.kill(-child.pid, 0);
      }).not.toThrow();
    } finally {
      await endIdleChild(child);
    }
  });

  it('leaves a child in its parent group when the platform is win32', async () => {
    const child = await startIdleChild('win32');

    try {
      // Alive, and still without a group of its own — which is what leaves
      // `taskkill /T` walking down from the pid as the only way to reach it.
      expect(() => {
        process.kill(child.pid, 0);
      }).not.toThrow();
      expect(() => {
        process.kill(-child.pid, 0);
      }).toThrow(/ESRCH/);
    } finally {
      await endIdleChild(child);
    }
  });

  it('starts the child for a process holding no run claim, recording nothing', async () => {
    const port = await freePort();

    const child = await startPortHolder([port]);

    expect(await untilObserved(() => isListening(port), FIXTURE_BOOT_BUDGET_MS)).toBe(true);
    expect(await enumerateClaims(registryDir)).toEqual([]);
    expect(child.pid).toBeGreaterThan(1);
  });

  it('frees the ports of the whole tree, not only the child it started', async () => {
    const childPort = await freePort();
    const grandchildPort = await freePort();
    const child = await startPortHolder([childPort, grandchildPort]);
    expect(await untilObserved(() => isListening(grandchildPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
      true
    );

    await child.kill('SIGKILL');

    expect(
      await untilObserved(
        async () => !(await isListening(grandchildPort)),
        SIGNAL_REACTION_BUDGET_MS
      )
    ).toBe(true);
    expect(await isListening(childPort)).toBe(false);
  });

  it('reports the exit code of a child that ended on its own', async () => {
    const child = await spawnLongLived(process.execPath, ['-e', 'process.exit(7)'], {
      stdio: 'ignore',
      forwarder: detachedForwarder,
      ports: [],
    });

    await expect(child.exit).resolves.toBe(7);
  });

  it('leaves its exit unanswered for as long as the child is still running', async () => {
    const child = await startIdleChild(process.platform);
    started.push(child);

    let answered = false;
    const record = async (): Promise<void> => {
      await child.exit;
      answered = true;
    };
    void record();

    // A handle that answers about a child still running answers about nothing,
    // and answers it in the shape of a real verdict — so the reading that
    // catches it is a negative one held open, never the code it came back with.
    expect(await untilObserved(() => Promise.resolve(answered), SURVIVAL_WINDOW_MS)).toBe(false);
  });

  it('reports a failure for a child a signal ended', async () => {
    const port = await freePort();
    const child = await startPortHolder([port]);

    await expect(child.kill('SIGKILL')).resolves.toBe(1);
  });

  it('forwards what the parent was asked to do to the tree', async () => {
    const port = await freePort();
    let forward: ((signal: 'SIGINT') => void) | undefined;
    const forwarder: TreeForwarder = {
      add: (tree) => {
        forward = tree.end;
        return (): void => {};
      },
    };
    const child = await startPortHolder([port], { forwarder });
    expect(await untilObserved(() => isListening(port), FIXTURE_BOOT_BUDGET_MS)).toBe(true);

    forward?.('SIGINT');

    await expect(child.exit).resolves.toBe(1);
    expect(await isListening(port)).toBe(false);
  });

  it('listens on this process for the signals it forwards, and stops once the tree is gone', async () => {
    // Measured from after a first spawn, not from nothing: a first spawn also
    // opens this process's socket and arranges for it to be closed on the way
    // out, and that listener belongs to the process rather than to any tree.
    const armed = await spawnLongLived(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      ports: [],
    });
    await armed.exit;
    const port = await freePort();
    const before = process.listenerCount('SIGINT');
    const exitsBefore = process.listenerCount('exit');

    const child = await spawnLongLived(process.execPath, portHolder([port]), {
      stdio: 'ignore',
      ports: [],
    });
    started.push(child);
    const during = process.listenerCount('SIGINT');
    await child.kill('SIGKILL');

    expect(during).toBe(before + 1);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(process.listenerCount('exit')).toBe(exitsBefore);
  });

  it('installs its process-level handlers once, however many trees it starts', async () => {
    const before = process.listenerCount('SIGINT');

    for (const port of [await freePort(), await freePort()]) {
      started.push(
        await spawnLongLived(process.execPath, portHolder([port]), {
          stdio: 'ignore',
          ports: [],
        })
      );
    }

    // One set of handlers for the process, not one per tree: the trees are what
    // the forwarder holds, and it is the thing installed on the process.
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });

  it('refuses to hand back a handle for a child that never started', async () => {
    await expect(
      spawnLongLived('hushbox-no-such-executable', [], {
        stdio: 'ignore',
        forwarder: detachedForwarder,
        ports: [],
      })
    ).rejects.toThrow(/did not start/);
  });

  it('names the code the runtime raised when a command cannot be started', async () => {
    expect(await messageOfUnstartableSpawn()).toContain('ENOENT');
  });

  it('names the command it tried to start', async () => {
    expect(await messageOfUnstartableSpawn()).toContain('hushbox-no-such-executable');
  });

  it('keeps a failed spawn to a single line', async () => {
    // The runtime's fuller account of the same failure runs to several lines
    // and can spell the directory it was given, so the code is what travels and
    // that account is not.
    const message = await messageOfUnstartableSpawn();

    expect(message.split('\n')).toHaveLength(1);
  });

  it('spells no directory when the spawn was given one that does not exist', async () => {
    // Every fuller account the runtime offers of this failure spells that
    // directory absolute, and an absolute path names the machine the run
    // happened on, so none of them may be what travels.
    const missing = path.join(registryDir, 'no-such-directory');

    expect(await messageOfUnstartableSpawn(missing)).not.toContain(missing);
  });
});

/**
 * What a genuine spawn of an unresolvable command raises, optionally from a
 * directory the caller names. Real, never a stub: the identity under test is
 * the one the runtime puts on the failure, so a fixture standing in for it
 * would be asserting the fixture.
 */
async function messageOfUnstartableSpawn(cwd?: string): Promise<string> {
  try {
    await spawnLongLived('hushbox-no-such-executable', [], {
      stdio: 'ignore',
      forwarder: detachedForwarder,
      ports: [],
      cwd,
    });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the unresolvable command started');
}

/** What a child found when it was started: the address it was given, and what answered there. */
async function probeChild(name: string): Promise<{
  readonly address: string;
  readonly answer: string;
}> {
  const report = path.join(registryDir, name);
  const child = await spawnLongLived(process.execPath, [LIFELINE_PROBE, report], {
    stdio: 'ignore',
    forwarder: detachedForwarder,
    ports: [],
  });
  await child.exit;
  const found = await fs.readFile(report, 'utf8');
  const [address, answer] = found.split('\n');
  return { address: address ?? '', answer: answer ?? '' };
}

describe('ending a real tree', () => {
  /** Never resolves, so only the child's own exit can end the wait. */
  const noGrace = (): Promise<void> => new Promise(() => {});

  it('stops a tree by asking it, and never has to signal its group', async () => {
    const child = await spawnLongLived(process.execPath, idleChild(), {
      stdio: 'ignore',
      forwarder: detachedForwarder,
      ports: [],
    });
    started.push(child);

    await endTrees([child], { grace: noGrace });

    // The wait ended because the child exited, which is the only thing that
    // could have ended it here — the budget was given nothing to run out.
    await expect(child.exit).resolves.toBe(1);
  });

  it('ends the group of a tree that ignored being asked', async () => {
    const child = await spawnLongLived(process.execPath, idleChild({ deaf: true }), {
      stdio: 'ignore',
      forwarder: detachedForwarder,
      ports: [],
    });
    started.push(child);

    await endTrees([child], { grace: () => Promise.resolve() });

    await expect(child.exit).resolves.toBe(1);
  });
});

describe('the lifeline a child is given', () => {
  it('hands the child an address this process is answering on', async () => {
    const { address, answer } = await probeChild('probe');

    expect(address).not.toBe('');
    expect(answer).toBe('answered');
  });

  it('hands every child the same address, this process having one socket to answer on', async () => {
    const first = await probeChild('first-probe');
    const second = await probeChild('second-probe');

    expect(second.address).toBe(first.address);
  });
});

describe('the socket this process answers on', () => {
  it('is gone, file and all, once this process is asked to let go of it', async () => {
    const { address } = await probeChild('closing-probe');

    await closeProcessLifeline();

    expect(await untilGone(address)).toBe(true);
  });

  it('is replaced by one of its own for the next child, which finds it answering', async () => {
    const before = await probeChild('before-closing');
    await closeProcessLifeline();

    const after = await probeChild('after-closing');

    expect(after.address).not.toBe(before.address);
    expect(after.answer).toBe('answered');
  });
});

/**
 * A forwarder over a host nothing installs anything on, so a case drives the
 * real forwarding decision without putting handlers on the vitest worker or
 * letting a re-raise end it.
 */
function drivenForwarder(): {
  readonly forwarder: TreeForwarder;
  readonly reraised: TreeSignal[];
  deliver(signal: TreeSignal): void;
} {
  const handlers = new Map<TreeSignal, (signal: TreeSignal) => void>();
  const reraised: TreeSignal[] = [];
  const forwarder = createTreeForwarder({
    on: (signal, handler) => handlers.set(signal, handler),
    off: (signal) => handlers.delete(signal),
    onExit: () => {},
    offExit: () => {},
    reraise: (signal) => reraised.push(signal),
  });
  return {
    forwarder,
    reraised,
    deliver: (signal) => handlers.get(signal)?.(signal),
  };
}

/**
 * What a case that starts this tree and then ends it may spend. It bounds
 * waiting and nothing else: every answer decided from here is a kernel fact —
 * a signal-zero probe, a connect, the child's own exit.
 *
 * Larger than the boot each of its processes takes by a margin, because a case
 * here waits on that tree more than once and whichever of those waits is going
 * to expire has to reach its own bound before the runner's timeout ends the
 * case — otherwise what surfaces is a generic timeout, which says a case was
 * slow rather than which process never arrived.
 */
const COLD_TREE_BUDGET_MS = FIXTURE_BOOT_BUDGET_MS * 3;

describe(
  'a real tree that ignored what its parent forwarded',
  { timeout: COLD_TREE_BUDGET_MS },
  () => {
    it('is gone, deepest member included, once that parent is asked the same thing again', async () => {
      const host = drivenForwarder();
      const ports = [await freePort(), await freePort()];
      const child = await spawnLongLived(process.execPath, portHolder(ports, { deaf: true }), {
        stdio: 'ignore',
        forwarder: host.forwarder,
        ports: [],
      });
      started.push(child);
      // Both addresses answering is what says every process of the tree is up
      // and holding its handlers: one signalled before that would be ended by
      // the default action, and the case would prove nothing.
      for (const port of ports)
        expect(await untilObserved(() => isListening(port), FIXTURE_BOOT_BUDGET_MS)).toBe(true);

      host.deliver('SIGTERM');
      // Still standing after being asked, which is what makes the second ask an
      // escalation rather than a repeat of something that already worked.
      expect(
        await untilObserved(() => Promise.resolve(!isAlive(child.pid)), SURVIVAL_WINDOW_MS)
      ).toBe(false);
      expect(await isListening(ports[1] ?? 0)).toBe(true);

      host.deliver('SIGTERM');

      // Read before the tree is waited on: the escalation hands control back
      // rather than blocking on a child that has already ignored one signal.
      expect(host.reraised).toEqual(['SIGTERM']);
      expect(
        await untilObserved(() => Promise.resolve(!isAlive(child.pid)), SIGNAL_REACTION_BUDGET_MS)
      ).toBe(true);
      await expect(child.exit).resolves.toBe(1);
      // The deepest member, read off the machine: the address it alone was
      // holding is free, which no record could have said.
      for (const port of ports)
        expect(
          await untilObserved(async () => !(await isListening(port)), SIGNAL_REACTION_BUDGET_MS)
        ).toBe(true);
    });
  }
);

describe('a tree that leaves a process behind', () => {
  it('resolves its handle when the child exits, though what the child started is still running', async () => {
    const child = await spawnLongLived(
      process.execPath,
      [LIFELINE_HANDOFF, registryDir, process.execPath, ...idleChild()],
      { stdio: 'ignore', forwarder: detachedForwarder, ports: [] }
    );
    started.push(child);

    // What a shell does with a backgrounded command: the child is gone while
    // what it started is still running. The handle answers for the child it was
    // handed back for, and nothing downstream can hold it open.
    await expect(child.exit).resolves.toBe(0);

    const left = Number(await fs.readFile(path.join(registryDir, 'handoff'), 'utf8'));
    expect(isAlive(left)).toBe(true);
    process.kill(left, 'SIGKILL');
  });
});

describe('a child that ends while the run is recording it', () => {
  /**
   * Writes the record only once the child it names has been reaped, so the
   * child's exit has certainly been delivered by the time the write returns.
   * A pid that no longer answers is a pid the runtime has already waited on,
   * and waiting on it is what delivers the exit — so this is the window the
   * handle has to already exist for, arranged rather than raced.
   *
   * `end` decides what the wait contains, so it decides the bound. Given one,
   * it ends the child as soon as the spawn hands back a pid, and a hard signal
   * lands whatever that child had reached: a reaction, with no boot in it.
   * Given none, nothing asks the child anything and the whole span is that
   * child's own interpreter starting and exiting, which is a boot.
   */
  function recordAfter(end?: (pid: number) => void): typeof addSpawnedProcess {
    return async (spawned) => {
      end?.(spawned.pid);
      expect(
        await untilObserved(
          () => Promise.resolve(!isAlive(spawned.pid)),
          end === undefined ? FIXTURE_BOOT_BUDGET_MS : SIGNAL_REACTION_BUDGET_MS
        )
      ).toBe(true);
      await addSpawnedProcess(spawned);
    };
  }

  it('reports the exit code of a child that ended before its record was written', async () => {
    await run(async () => {
      const child = await spawnLongLived(process.execPath, ['-e', 'process.exit(7)'], {
        stdio: 'ignore',
        forwarder: detachedForwarder,
        ports: [],
        record: recordAfter(),
      });
      started.push(child);

      await expect(child.exit).resolves.toBe(7);
    });
  });

  it('reports a failure for a child a signal ended before its record was written', async () => {
    await run(async () => {
      const child = await spawnLongLived(process.execPath, idleChild(), {
        stdio: 'ignore',
        forwarder: detachedForwarder,
        ports: [],
        record: recordAfter((pid) => {
          process.kill(pid, 'SIGKILL');
        }),
      });
      started.push(child);

      // A signal leaves no exit code at all, so a handle that asked only what
      // the child exited with would still be waiting here.
      await expect(child.exit).resolves.toBe(1);
    });
  });

  it('stops watching for signals once such a child has gone', async () => {
    const before = process.listenerCount('SIGINT');

    await run(async () => {
      const child = await spawnLongLived(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: 'ignore',
        ports: [],
        record: recordAfter(),
      });
      started.push(child);
      await child.exit;
    });

    // The bookkeeping that ends with the tree — the handler and the entry the
    // teardown walks — runs off the same handle, so a handle that never
    // settled would leak both.
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

/**
 * What a chain started by a bare spawn is handed, proven on a real process
 * rather than on the object the helper returns.
 *
 * Nothing but its environment can arm such a process against this run: it does
 * not run the spawner, so it is not handed an address by the call that made it.
 * A chain whose environment names none watches nothing, and a run killed while
 * one is up leaves it standing — which is the defect the fixture below exists
 * to keep out of this file, one hop higher.
 *
 * The address stood in for here is this process's own answering socket, so that
 * something answering is a fact the case establishes rather than a property of
 * however this run happened to be started.
 */
describe('the environment a chain of its own runs under', () => {
  it('names a socket the chain finds answering, so a killed run takes the chain with it', async () => {
    const chain = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-chain-env-'));
    const { address } = await probeChild('chain-host');
    const inherited = process.env[LIFELINE_ENV];
    process.env[LIFELINE_ENV] = address;
    try {
      const report = path.join(chain, 'probe');
      const probe = spawn(process.execPath, [LIFELINE_PROBE, report], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: chainEnvironment(chain),
      });
      await new Promise<void>((resolve) => {
        probe.once('exit', () => {
          resolve();
        });
      });

      const found = await fs.readFile(report, 'utf8');
      const [named, answer] = found.split('\n');
      expect(named).toBe(address);
      expect(answer).toBe('answered');
    } finally {
      // Removed rather than emptied where there was none: an address that is
      // present and names nothing is what `watchSpawner` refuses to run on.
      if (inherited === undefined) Reflect.deleteProperty(process.env, LIFELINE_ENV);
      else process.env[LIFELINE_ENV] = inherited;
      await fs.rm(chain, { recursive: true, force: true });
    }
  });
});

/**
 * The property every long-lived child this file starts has to have, proven on
 * the fixture itself rather than on the module.
 *
 * A case here ends what it started, and so does the hook after it — but a
 * `pnpm test` killed hard runs neither, and what it leaves is a real process on
 * a real machine that no claim names, no port reaches and nothing ever removes.
 * That is not a shortcoming of the tests: it is this repository's own stated
 * goal violated by the tooling that proves it, once per killed run, silently.
 *
 * So the chain here is real in every part. A process of its own starts the
 * fixture through the spawner, and it is killed with a signal it cannot catch,
 * which is the one way to show what a killed run does to what it started. Only
 * that process is signalled — never its group, which would reach the fixture by
 * itself and prove nothing about the mechanism.
 */
describe('the child fixture a case leaves running', () => {
  it('ends itself when the process that started it is killed hard', async () => {
    const chain = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-idle-child-'));
    // Started outside the block that ends it, so that the wait timing out or
    // the liveness check failing leaves nothing standing either: the chain is
    // two real processes, and a case whose subject is a leak may not be the
    // thing that leaks.
    const starter = spawn(
      process.execPath,
      ['--import', TSX_LOADER, LIFELINE_SPAWNER, chain, process.execPath, ...idleChild()],
      { stdio: ['ignore', 'ignore', 'inherit'], env: chainEnvironment(chain) }
    );
    let child: number | undefined;
    try {
      const spawned = Number(await untilNamed(chain, 'spawned'));
      child = spawned;
      expect(isAlive(spawned)).toBe(true);

      starter.kill('SIGKILL');

      expect(await untilSettled(() => !isAlive(spawned))).toBe(true);
    } finally {
      starter.kill('SIGKILL');
      // Reached only by a child the case has just failed to prove ends with its
      // starter, since that is what ending the starter does to it.
      if (child !== undefined && isAlive(child)) process.kill(child, 'SIGKILL');
      await fs.rm(chain, { recursive: true, force: true });
    }
  });
});

/**
 * The same property for the fixture that holds a port, which needed asking for
 * rather than assuming.
 *
 * A listener is the harder half of the same leak: it holds a real address as
 * well as a slot in the process table, and the ports it takes here are
 * ephemeral, so they sit outside every band a port reclaimer knows to look at.
 * Nothing named it, nothing reached it, and a `pnpm test` killed hard left one
 * standing for good.
 *
 * The chain is real in every part and only the starter is signalled, for the
 * same reason as the fixture above: a group signal would reach the listener by
 * itself and prove nothing about what its own arming does. The port is what the
 * case ends on, because a released address is the fact that matters to the next
 * run rather than an empty slot in the process table.
 */
describe('the listening fixture a case leaves running', () => {
  it('lets go of its port when the process that started it is killed hard', async () => {
    const chain = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-port-holder-'));
    const port = await freePort();
    // Started outside the block that ends it, so a wait that times out or an
    // assertion that fails leaves nothing standing either: a case whose subject
    // is a leak may not be the thing that leaks.
    const starter = spawn(
      process.execPath,
      ['--import', TSX_LOADER, LIFELINE_SPAWNER, chain, process.execPath, ...portHolder([port])],
      { stdio: ['ignore', 'ignore', 'inherit'], env: chainEnvironment(chain) }
    );
    let holder: number | undefined;
    try {
      const spawned = Number(await untilNamed(chain, 'spawned'));
      holder = spawned;
      expect(await untilObserved(() => isListening(port), FIXTURE_BOOT_BUDGET_MS)).toBe(true);

      starter.kill('SIGKILL');

      expect(await untilSettled(() => !isAlive(spawned))).toBe(true);
      expect(await isListening(port)).toBe(false);
    } finally {
      starter.kill('SIGKILL');
      // Reached only by a holder the case has just failed to prove ends with
      // its starter, since that is what ending the starter does to it.
      if (holder !== undefined && isAlive(holder)) process.kill(holder, 'SIGKILL');
      await fs.rm(chain, { recursive: true, force: true });
    }
  });
});
