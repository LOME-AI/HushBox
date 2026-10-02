import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  untilObserved,
} from '../bounded-wait.setup.js';
import { readOwnership } from '../claims/ownership.js';
import { RUN_CLAIM_ENV, enumerateClaims } from '../claims/registry.js';
import {
  selectIdentityResolver,
  selectListenerLookup,
  selectPgidResolver,
} from './process-probes.js';
import {
  killTree,
  reclaimLifelineSockets,
  reclaimProcessGroups,
  scanLifelineSockets,
} from './long-lived.js';
import type { Readable } from 'node:stream';

/**
 * What a killed `pnpm dev` leaves behind, and what the next command can do
 * about it. Every actor here is a real process: the run, the server it started,
 * and the server that server started. A test that faked any of them would be
 * asserting over its own fixture rather than over the thing this design exists
 * to survive — a process that was killed rather than asked to stop.
 *
 * The run runs through tsx's loader in-process (`--import`) rather than through
 * its CLI, which forks: a signal has to reach the process that holds the lock.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RUN_ENTRY = fileURLToPath(new URL('spawn-run-entry.mjs', import.meta.url));
/** The listener every run here starts, as its own command line names it. */
const HELPER_ENTRY = fileURLToPath(new URL('port-holder-entry.mjs', import.meta.url));
const SLOT = 3;

/**
 * What a case that starts real runs and then watches their trees may spend. It
 * bounds waiting and nothing else: every answer a case here decides from is a
 * kernel fact — a lock, a connect, a process's own exit.
 *
 * The most any case here waits on is five boots of ours and one socket going:
 * the two runs {@link startRun} starts announcing themselves, the three ports
 * their trees bind, and the port a reclaim frees. At the runner's default the
 * first wait to actually spend its budget outlives the case, and what surfaces
 * is a generic timeout — a case was slow — rather than the assertion naming
 * which port never answered.
 */
const RUN_TREE_CASE_TIMEOUT_MS = FIXTURE_BOOT_BUDGET_MS * 5 + SIGNAL_REACTION_BUDGET_MS;

type RunProcess = ChildProcessByStdio<null, Readable, null>;

interface StartedRun {
  readonly child: RunProcess;
  readonly runId: string;
  /** The group the run recorded, which is what a reclaimer would signal. */
  readonly pgid: number;
  readonly childPort: number;
  readonly grandchildPort: number;
}

let registryDir: string;
let socketDir: string;
let runs: RunProcess[];
let groups: number[];
let ports: number[];
let inheritedRunClaim: string | undefined;

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

function waitForExit(child: RunProcess): Promise<void> {
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
 * Every process group holding `port`, found the way a reclaimer finds one: from
 * the port alone, with no knowledge of who bound it.
 */
async function holdersOf(port: number): Promise<number[]> {
  return groupsOf(await selectListenerLookup()(port));
}

async function groupsOf(pids: readonly number[]): Promise<number[]> {
  const resolvePgid = selectPgidResolver();
  const found: number[] = [];
  for (const pid of pids) {
    const pgid = await resolvePgid(pid);
    if (pgid !== null) found.push(pgid);
  }
  return found;
}

/**
 * The groups of listeners on `port` that this file started, and only those.
 * Holding a port a run here allocated does not establish that a process is
 * ours: an ephemeral port is the kernel's to reissue the moment nothing holds
 * it. The command line does, because only these tests run that entry.
 */
async function startedHoldersOf(port: number): Promise<number[]> {
  const identityOf = selectIdentityResolver();
  const started: number[] = [];
  for (const pid of await selectListenerLookup()(port)) {
    const { command } = await identityOf(pid);
    if (command?.includes(HELPER_ENTRY) === true) started.push(pid);
  }
  return groupsOf(started);
}

/**
 * Ends every listener this file started on `ports` and waits for the last of
 * them to go, which the recorded groups cannot do on their own: a run that put
 * its grandchild in a group of its own is reachable through the recorded group
 * everywhere except at that grandchild, and the port is the handle that
 * outlives the difference.
 */
async function disposeStartedHelpers(ports: readonly number[]): Promise<boolean> {
  for (const port of ports) {
    for (const group of await startedHoldersOf(port)) killTree(group, 'SIGKILL');
  }
  return untilObserved(async () => {
    for (const port of ports) {
      const held = await startedHoldersOf(port);
      if (held.length > 0) return false;
    }
    return true;
  }, SIGNAL_REACTION_BUDGET_MS);
}

/** Starts a run in another process and resolves once it has registered and spawned. */
async function startRun(options: { readonly escape?: boolean } = {}): Promise<StartedRun> {
  const childPort = await freePort();
  const grandchildPort = await freePort();
  // Recorded before anything can bind them, so a run that fails between here
  // and its announcement is still disposable.
  ports.push(childPort, grandchildPort);
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      RUN_ENTRY,
      registryDir,
      'pnpm dev',
      'development',
      String(SLOT),
      path.join(registryDir, 'checkout', '.git'),
      String(childPort),
      String(grandchildPort),
      options.escape === true ? 'escape' : '',
    ],
    {
      env: {
        ...process.env,
        [RUN_CLAIM_ENV]: '',
        // Each run answers its children on a socket under a directory of this
        // case's own, so the socket of a run these cases kill hard — which no
        // runtime gets to clean up after — goes when that directory goes. It is
        // not the registry directory: every entry there is read as a run's
        // record, and a socket among them is not one.
        TMPDIR: socketDir,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );
  runs.push(child);

  const announced = await new Promise<string>((resolve, reject) => {
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
  const [runId, pgid] = announced.split(' ');
  groups.push(Number(pgid));

  return { child, runId: runId ?? '', pgid: Number(pgid), childPort, grandchildPort };
}

beforeEach(async () => {
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-reclaim-'));
  socketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-reclaim-sockets-'));
  runs = [];
  groups = [];
  ports = [];
  inheritedRunClaim = process.env[RUN_CLAIM_ENV];
  process.env[RUN_CLAIM_ENV] = '';
});

afterEach(async () => {
  // Ahead of the cleanup, because a cleanup that throws would otherwise skip it
  // and leave the worker without the claim this file was handed. Restored as
  // the empty string rather than removed: every reader treats an empty claim
  // variable as no claim, and a computed key cannot be deleted.
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  for (const group of groups) {
    if (Number.isInteger(group) && group > 1) killTree(group, 'SIGKILL');
  }
  for (const child of runs) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
  // Runs whether the test passed, failed or threw, because a leak that only
  // appears on the unhappy path is the same leak. The escaped grandchild is
  // what makes this more than the recorded-group and run-process kills: it is
  // the one process here no recorded group reaches.
  const disposed = await disposeStartedHelpers(ports);
  await fs.rm(registryDir, { recursive: true, force: true });
  await fs.rm(socketDir, { recursive: true, force: true });
  if (!disposed) {
    throw new Error('A listener this test started outlived the attempt to end it.');
  }
});

describe('a run that was killed', { timeout: RUN_TREE_CASE_TIMEOUT_MS }, () => {
  it('leaves every resource it owned classified as reclaimable', async () => {
    const run = await startRun();

    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    // The states each reclaimer reads before it destroys anything, and only
    // `owned-expired` licenses destruction. The killed run's own claim is what
    // produces it: a resource no claim names reads `unowned`, which is reported
    // and left standing.
    const ownership = await readOwnership(registryDir);
    expect(ownership.stateOfResource('port', String(run.childPort))).toBe('owned-expired');
    expect(ownership.stateOfResource('database', `hb_t_${String(SLOT)}`)).toBe('owned-expired');
    expect(ownership.stateOfResource('bucket', `hushbox-scratch-${String(SLOT)}`)).toBe(
      'owned-expired'
    );
    expect(ownership.stateOfResource('container', `hushbox-${String(SLOT)}-postgres`)).toBe(
      'owned-expired'
    );
  });

  it('leaves a record naming the tree it started, which still holds its ports', async () => {
    const run = await startRun();
    // Each port waited for on itself: the process holding `childPort` starts the
    // one holding `grandchildPort` before it binds, so the grandchild's port
    // answering is no evidence that the child's has been bound.
    expect(await untilObserved(() => isListening(run.childPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
      true
    );
    expect(await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
      true
    );

    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    // The orphan window is real: the servers outlive the run that started them.
    expect(await isListening(run.childPort)).toBe(true);
    expect(await isListening(run.grandchildPort)).toBe(true);
    const [found] = await enumerateClaims(registryDir);
    expect(found?.state).toBe('owned-expired');
    expect(found?.claim.spawned).toEqual([{ pid: run.pgid, pgid: run.pgid }]);
  });

  it('leaves the socket it answered on standing, named by the record that outlived it', async () => {
    const run = await startRun();
    const [address = ''] = await scanLifelineSockets(socketDir);
    expect(address).not.toBe('');

    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    // A signal this hard reaches no handler, and nothing releases for a run
    // that did not finish, so the file stays — owned by the record the killed
    // run left, which is what makes it reclaimable rather than unowned.
    const ownership = await readOwnership(registryDir);
    expect(ownership.stateOfResource('socket', address)).toBe('owned-expired');
    const report = await reclaimLifelineSockets({
      scan: () => scanLifelineSockets(socketDir),
      registryDir,
    });
    expect(report.reclaimed).toEqual([address]);
  });

  it('is reclaimed by the next command, which frees the ports the tree held', async () => {
    const run = await startRun();
    expect(await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
      true
    );
    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    // The reclaim the next command runs, driven exactly as that command drives
    // it. The grandchild is the case a pid alone cannot reach.
    const report = await reclaimProcessGroups({ registryDir, log: () => undefined });

    expect(report.reclaimed).toEqual([run.pgid]);
    expect(
      await untilObserved(
        async () => !(await isListening(run.grandchildPort)),
        SIGNAL_REACTION_BUDGET_MS
      )
    ).toBe(true);
    // The kernel's teardown of a listening socket outlives the process that
    // bound it — this port has been observed still accepting connections with
    // its process gone from `/proc` and no descriptor anywhere owning the
    // socket — so the grandchild's release is no evidence about the child's.
    expect(
      await untilObserved(
        async () => !(await isListening(run.childPort)),
        SIGNAL_REACTION_BUDGET_MS
      )
    ).toBe(true);
  });

  it('loses the entry naming the tree once that tree has been ended', async () => {
    const run = await startRun();
    expect(await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
      true
    );
    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    await reclaimProcessGroups({ registryDir, log: () => undefined });

    // An id the kernel has already handed on: every later pass of every command
    // would otherwise ask after it, and none of them could ever act on it.
    const [found] = await enumerateClaims(registryDir);
    expect(found?.claim.spawned).toEqual([]);
  });

  it('keeps every resource that same record names, which the other reclaimers read', async () => {
    const run = await startRun();
    expect(await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
      true
    );
    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    await reclaimProcessGroups({ registryDir, log: () => undefined });

    // The one thing narrowing the retirement to the entry buys: dropping the
    // record instead would move all of these from owned-expired, which is
    // culled, to unowned, which is reported and left standing forever.
    const ownership = await readOwnership(registryDir);
    expect(ownership.stateOfResource('port', String(run.childPort))).toBe('owned-expired');
    expect(ownership.stateOfResource('port', String(run.grandchildPort))).toBe('owned-expired');
    expect(ownership.stateOfResource('database', `hb_t_${String(SLOT)}`)).toBe('owned-expired');
    expect(ownership.stateOfResource('bucket', `hushbox-scratch-${String(SLOT)}`)).toBe(
      'owned-expired'
    );
    expect(ownership.stateOfResource('container', `hushbox-${String(SLOT)}-postgres`)).toBe(
      'owned-expired'
    );
  });

  it('keeps the socket that same record names, the one resource the pass could reach', async () => {
    const run = await startRun();
    const [address = ''] = await scanLifelineSockets(socketDir);
    expect(address).not.toBe('');
    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    await reclaimProcessGroups({ registryDir, log: () => undefined });

    const report = await reclaimLifelineSockets({
      scan: () => scanLifelineSockets(socketDir),
      registryDir,
    });
    expect(report.reclaimed).toEqual([address]);
  });
});

/**
 * The one case the whole design turns on, put to two real runs at once: the
 * pass has to tell a killed run's tree from a working colleague's, and getting
 * it wrong ends work nobody asked it to touch. Both runs are real processes
 * holding real locks, because the claim's lock is the entire evidence and a
 * fixture standing in for one would be asserting over itself.
 */
describe(
  'what the next command does to the trees the registry names',
  { timeout: RUN_TREE_CASE_TIMEOUT_MS },
  () => {
    it("ends a killed run's tree and leaves a live run's running", async () => {
      const killed = await startRun();
      const live = await startRun();
      expect(
        await untilObserved(() => isListening(killed.grandchildPort), FIXTURE_BOOT_BUDGET_MS)
      ).toBe(true);
      // The process holding `live.childPort` starts the one holding
      // `live.grandchildPort` before it binds, so the grandchild's port answering
      // is no evidence for the post-reclaim read that `live.childPort` is held.
      expect(await untilObserved(() => isListening(live.childPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
        true
      );
      expect(
        await untilObserved(() => isListening(live.grandchildPort), FIXTURE_BOOT_BUDGET_MS)
      ).toBe(true);
      killed.child.kill('SIGKILL');
      await waitForExit(killed.child);

      const report = await reclaimProcessGroups({ registryDir, log: () => undefined });

      expect(report).toEqual({ reclaimed: [killed.pgid], live: [live.pgid], refused: [] });
      expect(
        await untilObserved(
          async () => !(await isListening(killed.grandchildPort)),
          SIGNAL_REACTION_BUDGET_MS
        )
      ).toBe(true);
      expect(await isListening(live.childPort)).toBe(true);
      expect(await isListening(live.grandchildPort)).toBe(true);
    });
  }
);

describe('a run that was interrupted', { timeout: RUN_TREE_CASE_TIMEOUT_MS }, () => {
  it('releases its claim and leaves neither a record nor a running tree behind', async () => {
    const run = await startRun();
    expect(await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)).toBe(
      true
    );

    run.child.kill('SIGINT');
    await waitForExit(run.child);

    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
    // A listening socket outlives the process that bound it, and the run waits
    // for its child's exit, never for either socket's teardown.
    expect(
      await untilObserved(
        async () => !(await isListening(run.childPort)),
        SIGNAL_REACTION_BUDGET_MS
      )
    ).toBe(true);
    expect(
      await untilObserved(
        async () => !(await isListening(run.grandchildPort)),
        SIGNAL_REACTION_BUDGET_MS
      )
    ).toBe(true);
  });
});

describe('a run in flight', () => {
  it('is visible on its slot while it lives and gone from it once it has finished', async () => {
    const run = await startRun();

    const live = await enumerateClaims(registryDir);
    run.child.kill('SIGINT');
    await waitForExit(run.child);

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ state: 'owned-live', claim: { slot: SLOT, runId: run.runId } });
    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });
});

/**
 * The case a recorded process group cannot answer. `turbo` makes every task it
 * runs the leader of its own group, so every server behind `pnpm dev` sits
 * outside the group the spawner recorded: signalling that group empties it
 * while the servers keep their ports, reparented to init. The claim's ports are
 * what still name them.
 */
describe(
  'a run whose tree left the group it recorded',
  { timeout: RUN_TREE_CASE_TIMEOUT_MS },
  () => {
    it('empties the recorded group while the port that group no longer reaches stays held', async () => {
      const run = await startRun({ escape: true });
      expect(
        await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)
      ).toBe(true);
      run.child.kill('SIGKILL');
      await waitForExit(run.child);

      const [found] = await enumerateClaims(registryDir);
      for (const spawned of found?.claim.spawned ?? []) killTree(spawned.pgid, 'SIGKILL');

      expect(
        await untilObserved(
          async () => !(await isListening(run.childPort)),
          SIGNAL_REACTION_BUDGET_MS
        )
      ).toBe(true);
      expect(await isListening(run.grandchildPort)).toBe(true);
    });

    it('is reclaimed through the ports its claim names, which no group id could reach', async () => {
      const run = await startRun({ escape: true });
      expect(
        await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)
      ).toBe(true);
      run.child.kill('SIGKILL');
      await waitForExit(run.child);

      const ownership = await readOwnership(registryDir);
      expect(ownership.stateOfResource('port', String(run.grandchildPort))).toBe('owned-expired');
      for (const group of await holdersOf(run.grandchildPort)) killTree(group, 'SIGKILL');

      expect(
        await untilObserved(
          async () => !(await isListening(run.grandchildPort)),
          SIGNAL_REACTION_BUDGET_MS
        )
      ).toBe(true);
    });

    it('is disposed of through its port, the only handle the harness has left', async () => {
      const run = await startRun({ escape: true });
      expect(
        await untilObserved(() => isListening(run.grandchildPort), FIXTURE_BOOT_BUDGET_MS)
      ).toBe(true);
      run.child.kill('SIGKILL');
      await waitForExit(run.child);
      for (const group of groups) killTree(group, 'SIGKILL');

      await disposeStartedHelpers([run.childPort, run.grandchildPort]);

      // The helper returns once no process owns this port, and a listening socket
      // outlives the descriptors that held it: nothing here orders the teardown.
      expect(
        await untilObserved(
          async () => !(await isListening(run.grandchildPort)),
          SIGNAL_REACTION_BUDGET_MS
        )
      ).toBe(true);
    });
  }
);

describe('what the harness will signal', () => {
  it('leaves a listener it did not start alone', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    try {
      await expect(selectListenerLookup()(port)).resolves.not.toEqual([]);
      await expect(startedHoldersOf(port)).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
