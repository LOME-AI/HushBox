import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  FORWARDED_SIGNALS,
  LIFELINE_ENV,
  connectLifeline,
  createTreeForwarder,
  endTrees,
  hostLifeline,
  isSpawnerGone,
  killTree,
  lifelineAddress,
  parseProcStatGroupState,
  socketRemovalWasRefused,
  untilChildExit,
  watchSpawner,
} from './long-lived.js';
import type { ChildExitReport, LifelineHost, TreeSignal } from './long-lived.js';

// The cases below inject a platform rather than reading the host's. They prove
// which side of the branch was selected and nothing else: no case here is
// evidence that `taskkill /T` ends a tree on Windows, or that a group signal
// reaches one on macOS. Only a run on those systems establishes that.
describe('killTree', () => {
  it('signals the whole process group on posix', () => {
    const signal = vi.fn();

    killTree(4321, 'SIGTERM', { platform: 'linux', signal });

    expect(signal).toHaveBeenCalledWith(-4321, 'SIGTERM');
  });

  it('ends the tree by pid with taskkill on windows', () => {
    const run = vi.fn();

    killTree(4321, 'SIGTERM', { platform: 'win32', run });

    expect(run).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F']);
  });

  it('refuses a pid of 1, which negates into the signal-everything target', () => {
    const signal = vi.fn();

    expect(() => {
      killTree(1, 'SIGTERM', { platform: 'linux', signal });
    }).toThrow(/every process/);
    expect(signal).not.toHaveBeenCalled();
  });

  it('treats a tree that has already gone as killed', () => {
    const gone = (): never => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };

    expect(() => {
      killTree(4321, 'SIGTERM', { platform: 'linux', signal: gone });
    }).not.toThrow();
  });

  it('reports a signal that failed for any other reason', () => {
    const denied = (): never => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    };

    expect(() => {
      killTree(4321, 'SIGTERM', { platform: 'linux', signal: denied });
    }).toThrow(/EPERM/);
  });
});

// The kernel's own line, whose shape is the only thing these cases pin. That a
// group of corpses reads as gone is a property of real processes and is driven
// as one in `outlived-leader.test.ts`.
describe('parseProcStatGroupState', () => {
  it('reads the fields after a process name that holds spaces and a bracket', () => {
    expect(parseProcStatGroupState('4321 (odd (name) here) S 1 4242 4242 0 -1 4194560')).toEqual({
      state: 'S',
      pgrp: 4242,
    });
  });

  it('reports a collected process by the state it wears until it is', () => {
    expect(parseProcStatGroupState('4321 (node) Z 1 4242 4242 0 -1 4194560')?.state).toBe('Z');
  });

  it('reads nothing out of a line that never names a process', () => {
    expect(parseProcStatGroupState('4321 node S 1 4242')).toBeUndefined();
  });

  it('reads nothing out of a line that stops before the group', () => {
    expect(parseProcStatGroupState('4321 (node) S 1')).toBeUndefined();
  });
});

describe('createTreeForwarder', () => {
  function fakeProcess(): {
    readonly deps: Parameters<typeof createTreeForwarder>[0];
    readonly handlers: Map<string, (signal: TreeSignal) => void>;
    readonly reraised: TreeSignal[];
    readonly exits: (() => void)[];
  } {
    const handlers = new Map<string, (signal: TreeSignal) => void>();
    const reraised: TreeSignal[] = [];
    const exits: (() => void)[] = [];
    return {
      handlers,
      reraised,
      exits,
      deps: {
        on: (signal, handler) => handlers.set(signal, handler),
        off: (signal) => handlers.delete(signal),
        onExit: (handler) => exits.push(handler),
        offExit: (handler) => exits.splice(exits.indexOf(handler), 1),
        reraise: (signal) => reraised.push(signal),
      },
    };
  }

  it('forwards every signal a terminal can deliver to the tree', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder(host.deps);
    const killed: string[] = [];
    forwarder.add({ end: (signal) => killed.push(signal), standing: () => true });

    for (const signal of FORWARDED_SIGNALS) host.handlers.get(signal)?.(signal);

    expect(killed).toEqual([...FORWARDED_SIGNALS]);
  });

  it('asks a tree still standing when the parent exits to stop', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder({ ...host.deps, pause: () => {} });
    const killed: string[] = [];
    let standing = true;
    forwarder.add({
      end: (signal) => {
        killed.push(signal);
        standing = false;
      },
      standing: () => standing,
    });

    for (const onExit of host.exits) onExit();

    // Asked and not insisted on: a tree that went when it was asked was ended
    // by the ask, and the escalation has nothing left to reach.
    expect(killed).toEqual(['SIGTERM']);
  });

  it('insists on a tree that has not gone by the time the grace is spent', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder({ ...host.deps, pause: () => {} });
    const killed: string[] = [];
    forwarder.add({ end: (signal) => killed.push(signal), standing: () => true });

    for (const onExit of host.exits) onExit();

    // Ordered rather than merely both present: an uncatchable signal sent first
    // ends whatever would have relayed the ask onward.
    expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('waits between readings for a tree that has not gone yet', () => {
    const host = fakeProcess();
    const paused: number[] = [];
    const forwarder = createTreeForwarder({ ...host.deps, pause: (ms) => paused.push(ms) });
    forwarder.add({ end: () => {}, standing: () => true });

    for (const onExit of host.exits) onExit();

    // Read once and the answer is always "still there", so the escalation would
    // land in the same tick as the ask it is supposed to be escalating from.
    expect(paused.length).toBeGreaterThan(1);
  });

  it('signals nothing on the way out for a tree whose group has emptied', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder({ ...host.deps, pause: () => {} });
    const killed: string[] = [];
    forwarder.add({ end: (signal) => killed.push(signal), standing: () => false });

    for (const onExit of host.exits) onExit();

    // The id it was watched under is the kernel's to hand on once nothing is in
    // the group, so signalling it would reach whatever took the number.
    expect(killed).toEqual([]);
  });

  it('lets a repeated signal through to the default action', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder(host.deps);
    forwarder.add({ end: () => {}, standing: () => true });

    host.handlers.get('SIGINT')?.('SIGINT');
    const repeat = host.handlers.get('SIGINT');
    repeat?.('SIGINT');

    expect(host.reraised).toEqual(['SIGINT']);
  });

  it('ends every tree it watched when a repeated signal is about to end this process', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder(host.deps);
    const killed: string[] = [];
    forwarder.add({ end: (signal) => killed.push(signal), standing: () => true });

    host.handlers.get('SIGINT')?.('SIGINT');
    const repeat = host.handlers.get('SIGINT');
    repeat?.('SIGINT');

    // The default action runs nothing at all, so a tree not ended here is one
    // nothing ends: it is the escalation itself that would orphan it.
    expect(killed).toEqual(['SIGINT', 'SIGKILL']);
  });

  it('ends the tree before the repeated signal is let through', () => {
    const host = fakeProcess();
    const order: string[] = [];
    const forwarder = createTreeForwarder({
      ...host.deps,
      reraise: () => order.push('reraised'),
    });
    forwarder.add({ end: (signal) => order.push(signal), standing: () => true });

    host.handlers.get('SIGINT')?.('SIGINT');
    const repeat = host.handlers.get('SIGINT');
    repeat?.('SIGINT');

    // Ordered rather than merely both present: a kill issued after the process
    // has been handed to the default action is a kill that never runs.
    expect(order).toEqual(['SIGINT', 'SIGKILL', 'reraised']);
  });

  it('stops listening once the last tree it watched is gone', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder(host.deps);

    const stop = forwarder.add({ end: () => {}, standing: () => true });
    stop();

    expect(host.handlers.size).toBe(0);
    expect(host.exits).toEqual([]);
  });

  it('stops listening once, however many times it is told the tree is gone', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder(host.deps);
    const stop = forwarder.add({ end: () => {}, standing: () => true });
    stop();

    host.exits.push(() => {});
    stop();

    // The repeat stop must not take a listener it never installed off the host.
    expect(host.exits).toHaveLength(1);
  });

  it('keeps listening while another tree is still watched', () => {
    const host = fakeProcess();
    const forwarder = createTreeForwarder(host.deps);
    const killed: string[] = [];

    const stop = forwarder.add({ end: () => {}, standing: () => true });
    forwarder.add({ end: (signal) => killed.push(signal), standing: () => true });
    stop();
    host.handlers.get('SIGTERM')?.('SIGTERM');

    expect(killed).toEqual(['SIGTERM']);
  });
});

// Both cases below inject a platform rather than reading the host's, so each
// proves only which side of the branch was selected. Neither is evidence that
// Windows resolves a named pipe or that this host's socket layer accepts the
// path built for it: only a run on those systems establishes that, and nothing
// in this repository runs on Windows.
describe('lifelineAddress', () => {
  it('puts a posix address in the temporary directory it was given', () => {
    expect(lifelineAddress('a1b2c3', 'linux', path.join('var', 'scratch'))).toBe(
      path.join('var', 'scratch', 'hb-a1b2c3')
    );
  });

  it('names a pipe rather than a path on windows, which has no socket file', () => {
    expect(lifelineAddress('a1b2c3', 'win32', path.join('var', 'scratch'))).toBe(
      String.raw`\\.\pipe\hb-a1b2c3`
    );
  });

  it('refuses an address the kernel would truncate, and names the directory it came from', () => {
    const temporaryDir = path.join('var', 'x'.repeat(120));

    expect(() => lifelineAddress('a1b2c3', 'linux', temporaryDir)).toThrow(temporaryDir);
  });

  it('holds each posix kernel to its own limit, so one accepts what the other refuses', () => {
    // Ninety-five bytes of directory plus the ten the separator and the name
    // add sits inside Linux's 108-byte field and past the 104 bytes the BSD
    // kernel macOS is built on gives it.
    const temporaryDir = path.join('v', 'x'.repeat(93));

    expect(lifelineAddress('a1b2c3', 'linux', temporaryDir)).toContain(temporaryDir);
    expect(() => lifelineAddress('a1b2c3', 'darwin', temporaryDir)).toThrow(temporaryDir);
  });
});

describe('endTrees', () => {
  function tree(pid: number, exit: Promise<number>): { pid: number; exit: Promise<number> } {
    return { pid, exit };
  }

  it('asks each tree to stop, and asks the child itself rather than its group', async () => {
    const asked: number[] = [];
    const forced: number[] = [];

    await endTrees([tree(11, Promise.resolve(0)), tree(12, Promise.resolve(0))], {
      ask: (pid) => asked.push(pid),
      force: (pid) => forced.push(pid),
      grace: () => new Promise(() => {}),
    });

    expect(asked).toEqual([11, 12]);
    expect(forced).toEqual([]);
  });

  it('ends the group of a tree that has not gone by the end of the grace it was given', async () => {
    const forced: number[] = [];

    await endTrees([tree(11, new Promise<number>(() => {}))], {
      ask: () => {},
      force: (pid) => forced.push(pid),
      grace: () => Promise.resolve(),
    });

    expect(forced).toEqual([11]);
  });

  it('leaves a tree that stopped when it was asked, whatever the grace does after', async () => {
    const forced: number[] = [];

    await endTrees([tree(11, Promise.resolve(0)), tree(12, new Promise<number>(() => {}))], {
      ask: () => {},
      force: (pid) => forced.push(pid),
      grace: () => Promise.resolve(),
    });

    expect(forced).toEqual([12]);
  });

  it('signals nothing when there is no tree to end', async () => {
    const asked: number[] = [];

    await endTrees([], {
      ask: (pid) => asked.push(pid),
      force: () => {},
      grace: () => Promise.resolve(),
    });

    expect(asked).toEqual([]);
  });
});

describe('watchSpawner', () => {
  it('answers the end of the connection it holds', () => {
    let ended: (() => void) | undefined;
    let gone = false;

    const watching = watchSpawner(
      { [LIFELINE_ENV]: 'an-address' },
      () => ({
        onEnded: (handle) => {
          ended = handle;
        },
      }),
      () => {
        gone = true;
      }
    );
    ended?.();

    expect(watching).toBe(true);
    expect(gone).toBe(true);
  });

  it('connects to the address its environment names', () => {
    const connected: string[] = [];

    watchSpawner(
      { [LIFELINE_ENV]: 'an-address' },
      (address) => {
        connected.push(address);
        return { onEnded: () => {} };
      },
      () => {}
    );

    expect(connected).toEqual(['an-address']);
  });

  it('connects to nothing for a process at the head of a chain, which was started by no spawner', () => {
    let connected = false;

    const watching = watchSpawner(
      {},
      () => {
        connected = true;
        return { onEnded: () => {} };
      },
      () => {}
    );

    expect(watching).toBe(false);
    expect(connected).toBe(false);
  });

  it('refuses to run on unarmed for a process the spawner started and handed no address', () => {
    expect(() => {
      watchSpawner(
        { [LIFELINE_ENV]: '' },
        () => ({ onEnded: () => {} }),
        () => {}
      );
    }).toThrow(/names no address/);
  });
});

describe('isSpawnerGone', () => {
  it('reads a connection that broke after it was made as the spawner having gone', () => {
    expect(isSpawnerGone(true, 'ECONNRESET')).toBe(true);
  });

  it('reads an address that names nothing as the spawner having gone', () => {
    expect(isSpawnerGone(false, 'ENOENT')).toBe(true);
  });

  it('reads an address nobody answers on as the spawner having gone', () => {
    expect(isSpawnerGone(false, 'ECONNREFUSED')).toBe(true);
  });

  it('reads an answer withdrawn mid-connect as the spawner having gone', () => {
    expect(isSpawnerGone(false, 'ECONNRESET')).toBe(true);
  });

  it('reads a failure that is something else entirely as not that', () => {
    // Tearing a live tree down over a descriptor limit or a permission is the
    // false end-of-file this whole design is shaped to avoid.
    expect(isSpawnerGone(false, 'EACCES')).toBe(false);
  });

  it('reads a failure carrying no code at all as not that', () => {
    expect(isSpawnerGone(false)).toBe(false);
  });
});

describe('a lifeline between two processes', () => {
  let hosts: LifelineHost[];

  beforeEach(() => {
    hosts = [];
  });

  afterEach(() => {
    for (const host of hosts) host.close();
  });

  async function host(): Promise<LifelineHost> {
    const opened = await hostLifeline(
      lifelineAddress(randomBytes(5).toString('hex'), process.platform, os.tmpdir())
    );
    hosts.push(opened);
    return opened;
  }

  /** Resolves when the watcher is told its spawner has gone, and never otherwise. */
  function whenGone(address: string): Promise<void> {
    return new Promise((resolve) => {
      connectLifeline(address).onEnded(() => {
        resolve();
      });
    });
  }

  it('says nothing at all while the process holding it is answering', async () => {
    const opened = await host();
    let gone = false;

    connectLifeline(opened.address).onEnded(() => {
      gone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(gone).toBe(false);
  });

  it('tells a watcher the moment the process holding it stops answering', async () => {
    const opened = await host();
    const gone = whenGone(opened.address);

    opened.close();

    await expect(gone).resolves.toBeUndefined();
  });

  it('tells a watcher whose connection is refused, which is a spawner that had already gone', async () => {
    const opened = await host();
    opened.close();

    await expect(whenGone(opened.address)).resolves.toBeUndefined();
  });

  it('tells a watcher whose address names nothing at all', async () => {
    const address = lifelineAddress(randomBytes(5).toString('hex'), process.platform, os.tmpdir());

    await expect(whenGone(address)).resolves.toBeUndefined();
  });
});

describe('untilChildExit', () => {
  /**
   * A child in one of the three states the answer can arrive from. Declared
   * against the contract it stands in for, so a state the real thing carries
   * and this one does not is a compile error rather than a passing case.
   *
   * The two already-ended states are unreachable through a real spawn from
   * here: nothing runs between the spawn and the subscription, so a real child
   * cannot have ended in between. They are reachable for the caller this
   * exists for — anything that subscribes a turn of the loop later — which is
   * why the states are asked about rather than assumed away.
   */
  function endedChild(state: {
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
  }): ChildExitReport {
    return {
      ...state,
      on: () => {
        throw new Error('A child that has already ended never fires its exit event again.');
      },
    };
  }

  it('answers from the state of a child that had already exited', async () => {
    await expect(untilChildExit(endedChild({ exitCode: 7, signalCode: null }))).resolves.toBe(7);
  });

  it('answers from the state of a child a signal had already ended', async () => {
    // No exit code at all, which is what a signal leaves: the code alone would
    // say this child is still running.
    await expect(
      untilChildExit(endedChild({ exitCode: null, signalCode: 'SIGKILL' }))
    ).resolves.toBeNull();
  });

  it('waits for the event of a child that has not ended', async () => {
    let fire: ((code: number | null) => void) | undefined;
    const running: ChildExitReport = {
      exitCode: null,
      signalCode: null,
      on: (_event, listener) => {
        fire = listener;
      },
    };

    const status = untilChildExit(running);
    fire?.(0);

    await expect(status).resolves.toBe(0);
  });
});

/**
 * The failures that mean a socket file was not this user's to remove, put to
 * the decision directly: no kernel produces every one of them on demand, and
 * the two it does produce are driven through the whole reclaim by the cases of
 * the commands that call it.
 */
describe('the removal failures a reclaim can be asked to step over', () => {
  /** A failure in the shape the runtime raises them, with nothing else attached. */
  function failure(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: permission denied, unlink`), {
      code,
      syscall: 'unlink',
    });
  }

  it('reads the refusal a sticky directory gives as a removal this user may not make', () => {
    expect(socketRemovalWasRefused(failure('EPERM'))).toBe(true);
  });

  it('reads the refusal a directory\u2019s permissions give the same way', () => {
    expect(socketRemovalWasRefused(failure('EACCES'))).toBe(true);
  });

  it('reads a removal that failed for any other reason as no such refusal', () => {
    expect(socketRemovalWasRefused(failure('EIO'))).toBe(false);
  });

  it('reads a failure carrying no code at all as no such refusal', () => {
    expect(socketRemovalWasRefused(new Error('nothing the runtime raised'))).toBe(false);
  });

  it('reads something thrown that is not an object as no such refusal', () => {
    expect(socketRemovalWasRefused('not an error')).toBe(false);
  });
});
