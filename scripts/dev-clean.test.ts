import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import {
  resolvePorts,
  bandedHostBoundPorts,
  portsToClassify,
  listeningPorts,
  requireDatabaseUrl,
  auditedDatabaseNames,
  reclaimExitCode,
  reclaimPorts,
  reclaimGroups,
  reclaimSockets,
  auditStackWorld,
  type AuditPass,
  type PortReclaimOptions,
  type PortReclaimReport,
  type StackWorldSources,
} from './dev-clean.js';
import { selectIdentityResolver, selectListenerLookup } from './lib/spawn/process-probes.js';
import { auditExitCode } from './lib/claims/world-audit.js';
import { RECLAIM_BOUNDARY_PHRASE, UNOWNED_RECLAIM_AFTER_MS } from './lib/claims/resource-age.js';
import { RUN_CLAIM_ENV, addSpawnedProcess, registerRun } from './lib/claims/registry.js';
import { HELD_CLAIMS_ENV } from './lib/claims/claim.js';
import { recordOwnedResource } from './lib/claims/ownership.js';
import {
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  untilObserved,
} from './lib/bounded-wait.setup.js';
import { HOST_BOUND_PORT_ENVS, MODE_BANDED_PORT_ENVS } from './lib/stack/dev-ports.js';
import {
  PORT_RANGE,
  STACK_MODES,
  STACK_MODE_DECLARATIONS,
  portFor,
} from './lib/stack/port-plan.js';
import type { Server } from 'node:net';
import type { ListenerLookup, PgidResolver } from './lib/spawn/process-probes.js';
import type { UnmanagedContainer } from './docker-cleanup.js';
import type { WorldAuditReport } from './lib/claims/world-audit.js';
import type { LifelineSocketReport, ProcessGroupReclaimReport } from './lib/spawn/long-lived.js';
import type { SqlExecutor } from './lib/stack/stack-meta.js';

/** The stacks whose own processes listen on their allocation, and the stacks whose do not. */
const bindingModes = STACK_MODES.filter((mode) => STACK_MODE_DECLARATIONS[mode].bindsHostPorts);
const unboundModes = STACK_MODES.filter((mode) => !STACK_MODE_DECLARATIONS[mode].bindsHostPorts);

// Promise sugar so mocks satisfy the typed async signatures without being
// `async` themselves (eslint @typescript-eslint/require-await flags async
// functions that don't use await).
const ok = <T>(value: T): Promise<T> => Promise.resolve(value);

describe('dev-clean', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['KP_TEST_A'];
    delete process.env['KP_TEST_B'];
    delete process.env['KP_TEST_C'];
  });

  describe('resolvePorts', () => {
    it('reads port numbers from process.env for each name', () => {
      process.env['KP_TEST_A'] = '4321';
      process.env['KP_TEST_B'] = '5678';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321, 5678]);
    });

    it('skips env vars that are unset', () => {
      process.env['KP_TEST_A'] = '4321';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321]);
    });

    it('skips env vars that are non-numeric', () => {
      process.env['KP_TEST_A'] = '4321';
      process.env['KP_TEST_B'] = 'notaport';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B'])).toEqual([4321]);
    });

    it('skips env vars that are zero or negative', () => {
      process.env['KP_TEST_A'] = '0';
      process.env['KP_TEST_B'] = '-1';
      process.env['KP_TEST_C'] = '4321';
      expect(resolvePorts(['KP_TEST_A', 'KP_TEST_B', 'KP_TEST_C'])).toEqual([4321]);
    });

    it('returns empty array when no names provided', () => {
      expect(resolvePorts([])).toEqual([]);
    });
  });
});

describe('the ports the auditor watches', () => {
  afterEach(() => {
    delete process.env['HB_TEST_BAND_PORT'];
  });

  it('widens each environment port into the band of every stack that binds one', () => {
    // vite is mode-banded, so it holds one port per stack that binds.
    process.env['HB_TEST_BAND_PORT'] = String(portFor('vite', { slot: 3, mode: 'development' }));

    expect(bandedHostBoundPorts(['HB_TEST_BAND_PORT'])).toEqual(
      bindingModes
        .map((mode) => portFor('vite', { slot: 3, mode }))
        .toSorted((first, second) => first - second)
    );
  });

  it('leaves the band of a stack that binds nothing unprobed', () => {
    process.env['HB_TEST_BAND_PORT'] = String(portFor('vite', { slot: 3, mode: 'development' }));
    const unbound = unboundModes.map((mode) => portFor('vite', { slot: 3, mode }));

    expect(unbound.length).toBeGreaterThan(0);
    expect(bandedHostBoundPorts(['HB_TEST_BAND_PORT'])).not.toContain(unbound[0]);
  });

  it('yields one port for a service both bands share', () => {
    // The idle daemon is one sentinel per slot, watching both modes.
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });
    process.env['HB_TEST_BAND_PORT'] = String(sentinel);

    expect(bandedHostBoundPorts(['HB_TEST_BAND_PORT'])).toEqual([sentinel]);
  });

  it('ignores a port outside the allocation, which belongs to no band of ours', () => {
    process.env['HB_TEST_BAND_PORT'] = '5432';

    expect(bandedHostBoundPorts(['HB_TEST_BAND_PORT'])).toEqual([]);
  });

  it('defaults to this checkout banded ports, which name none when the environment does not', async () => {
    for (const name of HOST_BOUND_PORT_ENVS) vi.stubEnv(name, '');

    await expect(listeningPorts()).resolves.toEqual([]);
  });

  it('reports only the ports something is listening on', async () => {
    const lookup = vi.fn((port: number) => ok(port === 10_003 ? [4242] : []));

    await expect(listeningPorts({ ports: [10_003, 10_004], lookup })).resolves.toEqual([10_003]);
  });
});

describe('the ports a reclaim reads before it classifies anything', () => {
  // Every mode-banded name blanked first: this checkout's real environment
  // carries them all, so a test that only stubbed the one it names would be
  // asserting over the whole live allocation.
  beforeEach(() => {
    for (const name of MODE_BANDED_PORT_ENVS) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('widens the environment mode-banded ports into every binding stack band', () => {
    vi.stubEnv('HB_API_PORT', String(portFor('api', { slot: 7, mode: 'development' })));

    expect(portsToClassify()).toEqual(
      bindingModes
        .map((mode) => portFor('api', { slot: 7, mode }))
        .toSorted((first, second) => first - second)
    );
  });

  // The daemon is one sentinel per slot across both bands, so it is the one
  // host-bound service the mode-banded derivation leaves out — and a reclaim
  // that reached it would end the reclaimer everything else depends on.
  it('leaves out the idle daemon sentinel, which no run claims and every run needs', () => {
    vi.stubEnv(
      'HB_IDLE_DAEMON_PORT',
      String(portFor('idleDaemon', { slot: 7, mode: 'development' }))
    );

    expect(portsToClassify()).toEqual([]);
  });

  it('scans this checkout own mode-banded ports when the caller names none', async () => {
    const registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-default-ports-'));

    try {
      await expect(reclaimPorts({ registryDir })).resolves.toEqual({
        reclaimed: [],
        live: [],
        unowned: [],
      });
    } finally {
      await rm(registryDir, { recursive: true, force: true });
    }
  });
});

describe('the connection the auditor classifies databases through', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the loaded database url', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pw@localhost:4444/hushbox');

    expect(requireDatabaseUrl()).toBe('postgres://user:pw@localhost:4444/hushbox');
  });

  it.each(['', undefined])('refuses when the environment carries %j', (value) => {
    vi.stubEnv('DATABASE_URL', value);

    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL is not loaded/);
  });
});

describe('the databases the auditor classifies', () => {
  it('reads the per-run and the staged-template databases as one class', async () => {
    const query = vi.fn();
    query.mockImplementation((statement: string) =>
      Promise.resolve(
        statement.includes('hb_stage_')
          ? [{ datname: 'hb_stage_abc_1234' }]
          : [{ datname: 'hb_t_ab12cd34ef_w1' }]
      )
    );
    const executor: SqlExecutor = { exec: vi.fn(), query };

    await expect(auditedDatabaseNames(executor)).resolves.toEqual([
      'hb_t_ab12cd34ef_w1',
      'hb_stage_abc_1234',
    ]);
  });
});

/**
 * The three states, driven against an injected world so each one can be put
 * exactly where the assertion needs it. The executions over real processes
 * follow below; these fix the decision, those prove it survives contact.
 */
describe('what a port reclaim does with each of the three ownership states', () => {
  const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');
  const ELSEWHERE = path.join(path.sep, 'another-checkout', '.git');
  const PORT = 10_042;
  const HOLDER = 4242;
  const GROUP = 4200;

  let registryDir: string;
  let signalled: number[];
  let printed: string[];
  let inheritedRunClaim: string | undefined;

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-port-reclaim-'));
    inheritedRunClaim = process.env[RUN_CLAIM_ENV];
    process.env[RUN_CLAIM_ENV] = '';
    signalled = [];
    printed = [];
  });

  afterEach(async () => {
    // Empty string rather than absent: every reader treats an empty claim
    // variable as no claim, and a computed key cannot be deleted. Put back
    // rather than blanked, or every later suite in this file — and everything
    // else this worker goes on to run — creates resources no claim names.
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
  });

  /** A run holding a claim on `PORT` for as long as `body` takes. */
  function run<T>(init: { command: string; checkout: string }, body: () => Promise<T>): Promise<T> {
    return registerRun(
      {
        command: init.command,
        mode: 'development',
        slot: 4,
        gitCommonDir: init.checkout,
        registryDir,
      },
      async () => {
        await recordOwnedResource('port', String(PORT));
        return body();
      }
    );
  }

  /**
   * Runs `body` as a process that belongs to no run, which is what every
   * reclaimer but this run's own is. Without it a live claim taken here would
   * be the caller's own, and every `--all` assertion would pass vacuously.
   */
  async function asAnotherProcess<T>(body: () => Promise<T>): Promise<T> {
    const held = process.env[RUN_CLAIM_ENV];
    process.env[RUN_CLAIM_ENV] = '';
    try {
      return await body();
    } finally {
      process.env[RUN_CLAIM_ENV] = held ?? '';
    }
  }

  /** A run that recorded the port and then died, leaving the claim behind. */
  async function deadRun(command = 'pnpm dev'): Promise<void> {
    await expect(
      run({ command, checkout: CHECKOUT }, () => Promise.reject(new Error('killed')))
    ).rejects.toThrow('killed');
  }

  const holders: ListenerLookup = () => ok([HOLDER]);
  const groups: PgidResolver = (pid) => ok(pid === HOLDER ? GROUP : pid);

  function reclaim(options: Partial<PortReclaimOptions> = {}): Promise<PortReclaimReport> {
    return reclaimPorts({
      ports: [PORT],
      registryDir,
      lookup: holders,
      pgid: groups,
      identity: () => ok({ cwd: null, command: 'node server.js' }),
      // Answered rather than read off the machine: the holder these cases name
      // is a number, so a real reading would answer about whatever process
      // this machine happens to have under it while the case runs.
      age: () => ok({ kind: 'known', elapsedMs: HOUR_MS }),
      gitCommonDir: CHECKOUT,
      killer: {
        platform: 'linux',
        signal: (target) => {
          signalled.push(target);
        },
      },
      log: (message) => {
        printed.push(message);
      },
      ...options,
    });
  }

  it('ends the tree holding a port whose owning run has gone', async () => {
    await deadRun();

    const report = await reclaim();

    expect(signalled).toEqual([-GROUP]);
    expect(report.reclaimed).toEqual([PORT]);
  });

  it('leaves a port whose owning run still holds its claim untouched', async () => {
    const report = await run({ command: 'pnpm dev', checkout: CHECKOUT }, () =>
      asAnotherProcess(() => reclaim())
    );

    expect(signalled).toEqual([]);
    expect(report.live).toEqual([PORT]);
  });

  it('reports a port no claim names and leaves its holder running', async () => {
    const report = await reclaim();

    expect(signalled).toEqual([]);
    expect(report.unowned).toEqual([PORT]);
    expect(printed.join('\n')).toContain('--unowned');
  });

  it('names the unreadable live run rather than asserting no claim names the port', async () => {
    const runId = await registerRun(
      { command: 'pnpm test', mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      async () => {
        const runDir = process.env[RUN_CLAIM_ENV] ?? '';
        const record = path.join(runDir, 'run.json');
        const written: unknown = JSON.parse(await readFile(record, 'utf8'));
        await writeFile(
          record,
          JSON.stringify({
            ...(written as object),
            mode: 'a-mode-this-checkout-has-never-heard-of',
          })
        );
        await reclaim();
        return path.basename(runDir);
      }
    );

    const said = printed.join('\n');
    expect(said).not.toContain('no claim, live or expired');
    expect(said).toContain(runId);
  });

  /**
   * The line a listener nothing accounts for gets today, which is the line one
   * below the boundary must still get: written out rather than assembled from
   * the pieces that print it, because a test that builds the sentence the way
   * the code does cannot see the sentence change.
   */
  const REPORTED_TODAY =
    `port ${String(PORT)} is unowned — no claim, live or expired, names the run that created ` +
    `it, so it is left standing. Listening on it: pid ${String(HOLDER)} (unreadable working ` +
    'directory, node server.js). End it with `pnpm dev:clean --unowned` once you have confirmed ' +
    'it is yours.';

  it('ends the holder of an unclaimed port that has stood past the boundary, unasked', async () => {
    const report = await reclaim({
      age: () => ok({ kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS + HOUR_MS }),
    });

    expect(signalled).toEqual([-GROUP]);
    expect(report).toMatchObject({ reclaimed: [PORT], unowned: [] });
    expect(printed.join('\n')).toContain(RECLAIM_BOUNDARY_PHRASE);
  });

  it('leaves an unclaimed port below the boundary standing, and reports it as it does today', async () => {
    const report = await reclaim({
      age: () => ok({ kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS - HOUR_MS }),
    });

    expect(signalled).toEqual([]);
    expect(report.unowned).toEqual([PORT]);
    expect(printed).toEqual([REPORTED_TODAY]);
  });

  it('says how long an unclaimed port has stood could not be read rather than that it is fresh', async () => {
    const report = await reclaim({
      age: () => ok({ kind: 'unreadable', reason: 'the process filesystem has no record of it' }),
    });

    expect(signalled).toEqual([]);
    expect(report.unowned).toEqual([PORT]);
    expect(printed.join('\n')).toContain(REPORTED_TODAY);
    expect(printed.join('\n')).toContain('could not be read');
  });

  /**
   * The two states side by side in one pass, which is the only shape that shows
   * the boundary falling between them: a fixture holding one of each, read by
   * one reclaim, with what happened to each asserted against the other.
   */
  it('ends the unclaimed port past the boundary and leaves the one below it exactly as it was', async () => {
    const YOUNG = PORT + 1;
    const YOUNG_HOLDER = HOLDER + 1;
    const report = await reclaim({
      ports: [PORT, YOUNG],
      lookup: (port) => ok([port === PORT ? HOLDER : YOUNG_HOLDER]),
      pgid: (pid) => ok(pid === HOLDER ? GROUP : pid),
      age: (pid) =>
        ok({
          kind: 'known',
          elapsedMs:
            pid === HOLDER
              ? UNOWNED_RECLAIM_AFTER_MS + HOUR_MS
              : UNOWNED_RECLAIM_AFTER_MS - HOUR_MS,
        }),
    });

    expect(signalled).toEqual([-GROUP]);
    expect(report).toMatchObject({ reclaimed: [PORT], unowned: [YOUNG] });
    expect(printed).toContain(
      `port ${String(YOUNG)} is unowned — no claim, live or expired, names the run that created ` +
        `it, so it is left standing. Listening on it: pid ${String(YOUNG_HOLDER)} (unreadable ` +
        'working directory, node server.js). End it with `pnpm dev:clean --unowned` once you ' +
        'have confirmed it is yours.'
    );
  });

  it('ends the holder of an unclaimed port only when it is asked to', async () => {
    const report = await reclaim({ unowned: true });

    expect(signalled).toEqual([-GROUP]);
    expect(report).toMatchObject({ reclaimed: [PORT], unowned: [] });
  });

  it('ends a live run of this checkout when asked for all of them', async () => {
    const report = await run({ command: 'pnpm dev', checkout: CHECKOUT }, () =>
      asAnotherProcess(() => reclaim({ all: true }))
    );

    expect(signalled).toEqual([-GROUP]);
    expect(report.reclaimed).toEqual([PORT]);
  });

  it('leaves a live run of another checkout alone even when asked for all of them', async () => {
    const report = await run({ command: 'pnpm dev', checkout: ELSEWHERE }, () =>
      asAnotherProcess(() => reclaim({ all: true }))
    );

    expect(signalled).toEqual([]);
    expect(report.live).toEqual([PORT]);
  });

  it('never ends the run doing the reclaiming', async () => {
    const report = await run({ command: 'pnpm dev:clean', checkout: CHECKOUT }, () =>
      reclaim({ all: true })
    );

    expect(signalled).toEqual([]);
    expect(report.live).toEqual([PORT]);
  });

  it('never signals its own process group', async () => {
    await deadRun();

    const report = await reclaim({ pgid: () => ok(process.pid) });

    expect(signalled).toEqual([]);
    expect(report.reclaimed).toEqual([]);
  });

  it('leaves a holder whose tree cannot be addressed standing, rather than guessing', async () => {
    await deadRun();

    const report = await reclaim({ pgid: () => ok(null) });

    expect(signalled).toEqual([]);
    expect(report.reclaimed).toEqual([]);
  });

  it('refuses a process group that would broadcast rather than signalling it', async () => {
    await deadRun();
    // Group 1 only for the holder: answering it for this process too would
    // make the self-guard, rather than the refusal, the reason nothing is
    // signalled — and the refusal is what this asserts.
    const broadcast: PgidResolver = (pid) => ok(pid === HOLDER ? 1 : GROUP);

    await expect(reclaim({ pgid: broadcast })).rejects.toThrow(/Refusing to kill the tree/);
    expect(signalled).toEqual([]);
  });

  it('does not signal a holder that let go of the port after it was classified', async () => {
    await deadRun();
    // The reading that classifies a port and the signal that acts on it cannot
    // be one act. Between them the holder exits and the kernel hands the
    // address to a stranger; re-probing is what makes the difference visible.
    let probes = 0;
    const changesHands: ListenerLookup = () => {
      probes += 1;
      return ok([probes > 2 ? HOLDER + 1 : HOLDER]);
    };

    const report = await reclaim({ lookup: changesHands });

    expect(signalled).toEqual([]);
    expect(report.reclaimed).toEqual([]);
  });

  it('passes over a port in scope that nothing is listening on', async () => {
    await deadRun();

    const report = await reclaim({
      ports: [PORT, PORT + 1],
      lookup: (port) => ok(port === PORT ? [HOLDER] : []),
    });

    expect(report.reclaimed).toEqual([PORT]);
  });

  // The two platform branches, each driven by injecting the platform. They
  // prove only which branch is SELECTED — that a process group is what a
  // signal addresses on POSIX and the pid itself is what `taskkill /T`
  // addresses on Windows. Neither proves how either operating system behaves:
  // nothing in this run executes on Windows or macOS, so no test here can.
  it('addresses the tree by process group on POSIX, never by the listener pid', async () => {
    await deadRun();

    const report = await reclaim({
      killer: {
        platform: 'linux',
        signal: (target) => {
          signalled.push(target);
        },
      },
    });

    expect(signalled).toEqual([-GROUP]);
    expect(signalled).not.toContain(-HOLDER);
    expect(report.reclaimed).toEqual([PORT]);
  });

  // Selection only, as above: this asserts the pid reaches `taskkill`, not
  // that Windows ends the tree when it does.
  it('addresses the tree by pid on Windows, where no API addresses a group', async () => {
    await deadRun();
    const taskkill: string[][] = [];

    const report = await reclaim({
      killer: {
        platform: 'win32',
        run: (file, args) => {
          taskkill.push([file, ...args]);
        },
      },
    });

    expect(taskkill).toEqual([['taskkill', '/PID', String(HOLDER), '/T', '/F']]);
    expect(report.reclaimed).toEqual([PORT]);
  });

  it('prints through the console when the caller names no reporter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await reclaimPorts({ ports: [PORT], registryDir, lookup: holders, pgid: groups });

      expect(warn.mock.calls.flat().join('\n')).toContain('--unowned');
    } finally {
      warn.mockRestore();
    }
  });

  it('reclaims nothing from a world that never held still', async () => {
    await deadRun();
    // A listener appearing between the two readings of a pass invalidates it:
    // the pass would otherwise classify a resource against a registry that was
    // written before that resource's claim was.
    let reading = 0;
    const restless: ListenerLookup = () => {
      reading += 1;
      return ok([HOLDER + reading]);
    };

    const report = await reclaim({ lookup: restless });

    expect(signalled).toEqual([]);
    expect(report).toEqual({ reclaimed: [], live: [], unowned: [] });
  });
});

/**
 * The same three states against real processes on real ports. Every actor is a
 * process this file started: a registered run, the listener that run spawned,
 * and a listener nothing registered. A fixture standing in for any of them
 * would be asserting over itself.
 */
describe('a port reclaim over real listeners', () => {
  const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const RUN_ENTRY = fileURLToPath(new URL('lib/spawn/spawn-run-entry.mjs', import.meta.url));
  const PORT_HOLDER = fileURLToPath(new URL('lib/spawn/port-holder-entry.mjs', import.meta.url));
  const SLOT = 5;

  let registryDir: string;
  let socketDir: string;
  let started: ChildProcess[];
  let ports: number[];
  let inherited: string | undefined;

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
   * The listeners on `port` this file started, and only those. Holding a port
   * allocated here does not make a process ours — an ephemeral port is the
   * kernel's to reissue — but running this entry does, because nothing else
   * runs it.
   */
  async function startedHoldersOf(port: number): Promise<number[]> {
    const identityOf = selectIdentityResolver();
    const mine: number[] = [];
    for (const pid of await selectListenerLookup()(port)) {
      const { command } = await identityOf(pid);
      if (command?.includes(PORT_HOLDER) === true) mine.push(pid);
    }
    return mine;
  }

  /** A registered run holding two real ports, one of them through a grandchild. */
  async function startRun(): Promise<{ child: ChildProcess; port: number }> {
    const port = await freePort();
    const deeper = await freePort();
    ports.push(port, deeper);
    const child = spawn(
      process.execPath,
      [
        '--import',
        TSX,
        RUN_ENTRY,
        registryDir,
        'pnpm dev',
        'development',
        String(SLOT),
        path.join(registryDir, 'checkout', '.git'),
        String(port),
        String(deeper),
        '',
      ],
      {
        env: {
          ...process.env,
          [RUN_CLAIM_ENV]: '',
          // Each run answers its children on a socket under a directory of this
          // case's own, so the socket of a run these cases kill hard — which no
          // runtime gets to clean up after — goes when that directory goes.
          TMPDIR: socketDir,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    );
    started.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => {
        resolve();
      });
      child.once('error', reject);
      child.once('exit', () => {
        resolve();
      });
    });
    expect(await untilObserved(() => isListening(port), FIXTURE_BOOT_BUDGET_MS)).toBe(true);
    return { child, port };
  }

  /**
   * A listener nothing registered: the unowned state, as a real process.
   *
   * Armed against whatever started this run, and therefore run through the
   * loader, because nothing else would ever end it: a run killed hard runs no
   * hook, no claim names this listener, and the port it holds is ephemeral, so
   * it falls outside every band a port reclaimer looks at. This spawn publishes
   * no address of its own — the fixture watches whatever this process inherited
   * and holds its port either way — which is why arming it does not make it
   * owned, and why a run started without a wrapper still gets this case.
   */
  async function startStranger(): Promise<number> {
    const port = await freePort();
    ports.push(port);
    started.push(
      spawn(process.execPath, ['--import', TSX, PORT_HOLDER, String(port), '--watch-spawner'], {
        detached: true,
        stdio: 'ignore',
      })
    );
    expect(await untilObserved(() => isListening(port), FIXTURE_BOOT_BUDGET_MS)).toBe(true);
    return port;
  }

  function reclaim(options: Partial<PortReclaimOptions> = {}): Promise<PortReclaimReport> {
    return reclaimPorts({
      ports,
      registryDir,
      gitCommonDir: path.join(registryDir, 'checkout', '.git'),
      log: () => {
        /* the assertions read the report; the console is for the developer */
      },
      ...options,
    });
  }

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-real-reclaim-'));
    socketDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-real-reclaim-sockets-'));
    started = [];
    ports = [];
    inherited = process.env[RUN_CLAIM_ENV];
    process.env[RUN_CLAIM_ENV] = '';
  });

  afterEach(async () => {
    // Ahead of the cleanup, because a cleanup that throws would otherwise skip
    // it and leave the worker without the claim this file was handed.
    process.env[RUN_CLAIM_ENV] = inherited ?? '';
    // Runs whether the test passed, failed or threw: a leak that appears only
    // on the unhappy path is the same leak.
    for (const port of ports) {
      for (const pid of await startedHoldersOf(port)) process.kill(pid, 'SIGKILL');
    }
    for (const child of started) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
    const disposed = await untilObserved(async () => {
      for (const port of ports) {
        const holding = await startedHoldersOf(port);
        if (holding.length > 0) return false;
      }
      return true;
    }, SIGNAL_REACTION_BUDGET_MS);
    await rm(registryDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
    if (!disposed) throw new Error('A listener this test started outlived the attempt to end it.');
  });

  it('leaves the listener of a live run listening', async () => {
    const { port } = await startRun();

    const report = await reclaim();

    expect(report.live).toContain(port);
    expect(report.reclaimed).toEqual([]);
    expect(await isListening(port)).toBe(true);
  });

  it('frees the port a killed run left its listener holding', async () => {
    const { child, port } = await startRun();

    child.kill('SIGKILL');
    await waitForExit(child);
    expect(await isListening(port)).toBe(true);
    const report = await reclaim();

    expect(report.reclaimed).toContain(port);
    expect(
      await untilObserved(async () => !(await isListening(port)), SIGNAL_REACTION_BUDGET_MS)
    ).toBe(true);
  });

  it('leaves a listener no claim names running, and names it instead', async () => {
    const port = await startStranger();
    const printed: string[] = [];

    const report = await reclaim({
      log: (message) => {
        printed.push(message);
      },
    });

    expect(report.unowned).toEqual([port]);
    expect(await isListening(port)).toBe(true);
    expect(printed.join('\n')).toContain(String(port));
  });

  it('ends that same listener once it is explicitly asked to', async () => {
    const port = await startStranger();

    const report = await reclaim({ unowned: true });

    expect(report.reclaimed).toEqual([port]);
    expect(
      await untilObserved(async () => !(await isListening(port)), SIGNAL_REACTION_BUDGET_MS)
    ).toBe(true);
  });
});

/**
 * The socket files `pnpm dev:clean` reclaims, over files the kernel made and
 * refusals the operating system gave.
 *
 * Every file here is one the kernel made, and every refusal is the kernel's
 * own: what this command does with a file turns entirely on the answer the
 * kernel gives about it, so an injected error would assert over the injection
 * instead of over the decision.
 */
describe('the socket files the clean command reclaims', () => {
  const SLOT = 47;
  let registryDir = '';
  let socketDir = '';
  let refusedDirectories: string[] = [];
  let printed: string[] = [];

  const log = (message: string): void => {
    printed.push(message);
  };

  /** A real listener answering at `address`, for a case that needs something behind the file. */
  async function listenOn(address: string): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  }

  /** Stops a listener this case started, and waits for it to have stopped. */
  function stopListening(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /** A socket file the kernel made and nothing answers on, at `address`. */
  async function staleSocket(address: string): Promise<string> {
    const listened = `${address}.listening`;
    const server = await listenOn(listened);
    // Renamed out from under its listener, so closing the server unlinks a name
    // nothing holds and the file it made stays where a killed process left one.
    await rename(listened, address);
    await stopListening(server);
    return address;
  }

  function runOf(command: string): Parameters<typeof registerRun>[0] {
    return {
      command,
      mode: 'development',
      slot: SLOT,
      gitCommonDir: path.join(registryDir, 'checkout', '.git'),
      registryDir,
    };
  }

  /**
   * A pass over two directories: one this user may not write, holding a file it
   * therefore may not remove, and one it may. The scan is given directly so the
   * refused file is reached first — a refusal that raised out of the pass would
   * leave the file behind it unexamined, and the next run would stop in the
   * same place.
   *
   * Two directories because the refusal a case can produce is a directory's
   * permissions, which refuses every file in it alike. The per-file shape — a
   * sticky directory holding another user's file — needs a second user on the
   * machine to set up.
   *
   * The directory's mode is put back as soon as the pass is over, because the
   * teardown that removes it needs the permission this took away; the removal
   * itself waits for the teardown, so a case can still ask what is standing.
   */
  async function passOverARefusedFile(): Promise<{
    refused: string;
    reclaimable: string;
    report: LifelineSocketReport;
  }> {
    const refusedDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-clean-socket-refused-'));
    refusedDirectories.push(refusedDir);
    const refused = await staleSocket(path.join(refusedDir, 'hb-0123456789'));
    const reclaimable = await staleSocket(path.join(socketDir, 'hb-abcdef0123'));
    await chmod(refusedDir, 0o555);

    try {
      const report = await reclaimSockets({
        scan: () => Promise.resolve([refused, reclaimable]),
        registryDir,
        log,
      });
      return { refused, reclaimable, report };
    } finally {
      await chmod(refusedDir, 0o755);
    }
  }

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-clean-socket-registry-'));
    socketDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-clean-socket-scratch-'));
    // The invocation running this suite is itself a registered run and
    // advertises it in the environment every child inherits, so a case
    // registering its own run would adopt that one instead.
    vi.stubEnv(RUN_CLAIM_ENV, '');
    vi.stubEnv(HELD_CLAIMS_ENV, '');
    refusedDirectories = [];
    printed = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of refusedDirectories) await rm(dir, { recursive: true, force: true });
    await rm(registryDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  });

  it('reclaims the file behind one it was refused permission to remove', async () => {
    const { refused, reclaimable, report } = await passOverARefusedFile();

    expect(report).toEqual({
      reclaimed: [reclaimable],
      live: [],
      unowned: [],
      refused: [refused],
    });
    expect(existsSync(reclaimable)).toBe(false);
  });

  it('leaves the one it was refused permission to remove standing', async () => {
    const { refused } = await passOverARefusedFile();

    expect(existsSync(refused)).toBe(true);
  });

  it('names the file it was refused permission to remove', async () => {
    const { refused } = await passOverARefusedFile();

    expect(printed.join('\n')).toContain(refused);
  });

  it('says the operating system is why that removal did not go', async () => {
    await passOverARefusedFile();

    expect(printed.join('\n')).toContain('the operating system refused it');
  });

  it('raises where a removal fails for anything other than a refusal', async () => {
    // A path whose parent is a regular file: the unlink fails with the kernel's
    // own `ENOTDIR`, which is neither a refusal nor the file having gone. The
    // claim is what carries the pass to a removal at all — an expired one is
    // removed on the claim alone, so nothing here turns on what a connect would
    // have answered.
    const notADirectory = path.join(socketDir, 'hb-not-a-directory');
    await writeFile(notADirectory, '');
    const address = path.join(notADirectory, 'hb-0123456789');
    await expect(
      registerRun(runOf('pnpm dev'), async () => {
        await recordOwnedResource('socket', address);
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');

    await expect(
      reclaimSockets({ scan: () => Promise.resolve([address]), registryDir, log })
    ).rejects.toThrow(/ENOTDIR/);
  });

  it('leaves a file a real listener answers on standing', async () => {
    const address = path.join(socketDir, 'hb-abcdef0123');
    const server = await listenOn(address);

    const report = await reclaimSockets({
      scan: () => Promise.resolve([address]),
      registryDir,
      log,
    });

    expect(report).toEqual({ reclaimed: [], live: [], unowned: [address], refused: [] });
    expect(existsSync(address)).toBe(true);
    await stopListening(server);
  });
});

/**
 * What `pnpm dev:clean` leaves with, put to the decision directly: the pass
 * that produces these lists is driven by the cases above, and this is the one
 * question asked of them afterwards.
 */
describe('what the clean command exits with', () => {
  const NOTHING_FOUND: PortReclaimReport = { reclaimed: [], live: [], unowned: [] };
  const NO_SOCKETS: LifelineSocketReport = {
    reclaimed: [],
    live: [],
    unowned: [],
    refused: [],
  };
  const NO_GROUPS: ProcessGroupReclaimReport = { reclaimed: [], live: [], refused: [] };

  it('exits zero where nothing it found asks anything of anyone', () => {
    expect(
      reclaimExitCode(
        { reclaimed: [5173], live: [8787], unowned: [] },
        { ...NO_SOCKETS, reclaimed: ['hb-0123456789'], live: ['hb-abcdef0123'] },
        { ...NO_GROUPS, reclaimed: [4321], live: [8765] }
      )
    ).toBe(0);
  });

  it('exits non-zero over a listener nothing accounts for', () => {
    expect(reclaimExitCode({ ...NOTHING_FOUND, unowned: [5173] }, NO_SOCKETS, NO_GROUPS)).toBe(1);
  });

  it('exits non-zero over a socket file nothing accounts for', () => {
    expect(
      reclaimExitCode(NOTHING_FOUND, { ...NO_SOCKETS, unowned: ['hb-0123456789'] }, NO_GROUPS)
    ).toBe(1);
  });

  it('exits non-zero over a socket file it was refused permission to remove', () => {
    expect(
      reclaimExitCode(NOTHING_FOUND, { ...NO_SOCKETS, refused: ['hb-0123456789'] }, NO_GROUPS)
    ).toBe(1);
  });

  it('exits non-zero over a tree it was refused permission to end', () => {
    expect(reclaimExitCode(NOTHING_FOUND, NO_SOCKETS, { ...NO_GROUPS, refused: [4321] })).toBe(1);
  });
});

/**
 * The clean command's third pass. Every decision about a tree is the reclaim's;
 * what this adds is the refusal both of this repository's commands step over,
 * so one tree this user may not end does not stop the pass reaching the trees
 * behind it.
 */
describe('the trees the clean command reclaims', () => {
  let registryDir: string;
  let started: number[];

  function detachedGroup(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const { pid } = child;
    if (pid === undefined) throw new Error('the fixture child did not start');
    started.push(pid);
    return pid;
  }

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-clean-group-registry-'));
    vi.stubEnv(RUN_CLAIM_ENV, '');
    vi.stubEnv(HELD_CLAIMS_ENV, '');
    started = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const pgid of started) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // Already gone is the outcome this wanted.
      }
    }
    await rm(registryDir, { recursive: true, force: true });
  });

  it('ends the tree of a run that has gone', async () => {
    let pgid = 0;
    await expect(
      registerRun(
        {
          command: 'pnpm dev',
          mode: 'development',
          slot: 3,
          gitCommonDir: path.join(registryDir, 'checkout', '.git'),
          registryDir,
        },
        async () => {
          // Started inside the run, so the tree carries that run's record in
          // its environment exactly as a spawned child does — which is what the
          // pass reads before it signals anything.
          pgid = detachedGroup();
          await addSpawnedProcess({ pid: pgid, pgid });
          throw new Error('killed');
        }
      )
    ).rejects.toThrow('killed');

    const report = await reclaimGroups({ registryDir, log: () => undefined });

    expect(report).toEqual({ reclaimed: [pgid], live: [], refused: [] });
  });

  it('steps over a tree the operating system refuses it, rather than raising', async () => {
    let pgid = 0;
    await expect(
      registerRun(
        {
          command: 'pnpm dev',
          mode: 'development',
          slot: 3,
          gitCommonDir: path.join(registryDir, 'checkout', '.git'),
          registryDir,
        },
        async () => {
          pgid = detachedGroup();
          await addSpawnedProcess({ pid: pgid, pgid });
          throw new Error('killed');
        }
      )
    ).rejects.toThrow('killed');

    const report = await reclaimGroups({
      registryDir,
      log: () => undefined,
      killer: {
        platform: 'linux',
        signal: () => {
          throw Object.assign(new Error('kill: EPERM'), { code: 'EPERM' });
        },
      },
    });

    expect(report).toEqual({ reclaimed: [], live: [], refused: [pgid] });
  });
});

/**
 * The audit as `pnpm dev:clean` runs it, over a world that holds still.
 *
 * Every class is supplied here, so the one thing left for the pass to work out
 * is what it derives for itself: the creation time docker printed for each
 * container, turned into the age the boundary is read against. That derivation
 * is the kind nothing observes until it is wrong — a pass that never puts the
 * age question reports a world of ancient containers exactly as it reports one
 * of fresh ones — so these cases drive the command's own entry rather than
 * examine what it declares.
 */
describe('the world a clean pass reports on', () => {
  const EMULATOR = 'hushbox-emulator-left-behind';
  /** Outside every band, so the pass puts no sentinel question to the machine about it. */
  const UNBANDED_PORT = PORT_RANGE.first - 1;
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'hushbox-clean-world-'));
    vi.stubEnv(RUN_CLAIM_ENV, '');
    vi.stubEnv(HELD_CLAIMS_ENV, '');
    // Only the clock: the pass takes locks and reads directories, and faking
    // the timers those wait on would stall them rather than steady them.
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  });

  /**
   * An instant in the shape docker prints a container's creation time in,
   * rendered at zero offset so the zone of whatever host runs these decides
   * nothing.
   */
  function dockerCreatedAt(instantMs: number): string {
    const [date, clock] = isoAt(instantMs).split(/[TZ.]/);
    return `${date ?? ''} ${clock ?? ''} +0000 UTC`;
  }

  /** The one container these cases name, as docker dated it `elapsedMs` ago. */
  function createdAgo(elapsedMs: number): UnmanagedContainer {
    return { name: EMULATOR, createdAt: dockerCreatedAt(TEST_DAY_START - elapsedMs) };
  }

  /**
   * A world holding nothing but the containers a case names. Frozen down to the
   * platform, so what a case answers is about the audit and never about the
   * host it ran on.
   */
  function worldOf(containers: readonly UnmanagedContainer[]): StackWorldSources {
    return {
      registryDir: scratch,
      platform: 'linux',
      ramHost: { platform: 'linux', parent: path.join(scratch, 'shm') },
      containers: () => ok(containers),
      stuckContainers: () => ok([]),
      databases: () => ok([]),
      buckets: () => ok([]),
      listeningPorts: () => ok([]),
      listenerAge: () => ok({ kind: 'known', elapsedMs: MINUTE_MS }),
      lifelineSockets: () => ok([]),
      composeProjects: () =>
        ok({
          ownerships: [],
          activeWorktreePaths: [],
          repoCommonDir: path.join(scratch, '.git'),
          slotOfWorktree: () => null,
        }),
      processes: () => ok({ kind: 'read', processes: [] }),
    };
  }

  /** One resource of every class a frozen reading can hold, and no container. */
  function everyOtherClass(): StackWorldSources {
    return {
      ...worldOf([]),
      stuckContainers: () => ok([{ name: 'hushbox-stack-web-1', state: 'exited' }]),
      databases: () => ok(['hushbox_run_left_behind']),
      buckets: () => ok(['hushbox-scratch-left-behind']),
      listeningPorts: () => ok([UNBANDED_PORT]),
      lifelineSockets: () => ok([path.join(scratch, 'spawner.sock')]),
      probeSocket: () => ok({ kind: 'refused' }),
    };
  }

  interface AuditRun {
    readonly messages: readonly string[];
    readonly report: WorldAuditReport;
  }

  async function auditOver(
    world: StackWorldSources,
    pass: AuditPass = 'report'
  ): Promise<AuditRun> {
    const messages: string[] = [];
    const report = await auditStackWorld(
      scratch,
      (message) => {
        messages.push(message);
      },
      pass,
      world
    );
    return { messages, report };
  }

  /** The one line a run printed about the container, or nothing where it printed none. */
  function containerLine(run: AuditRun): string | undefined {
    return run.messages.find((message) => message.includes(EMULATOR));
  }

  it('says the next pass reclaims a container nothing accounts for that has stood past the boundary', async () => {
    const run = await auditOver(worldOf([createdAgo(UNOWNED_RECLAIM_AFTER_MS + HOUR_MS)]));

    expect(containerLine(run)).toContain(RECLAIM_BOUNDARY_PHRASE);
  });

  it('asks nobody to act on a container the next pass reclaims', async () => {
    const run = await auditOver(worldOf([createdAgo(UNOWNED_RECLAIM_AFTER_MS + HOUR_MS)]));

    expect(auditExitCode(run.report.lines, run.report.unreadable)).toBe(0);
  });

  it('empties a stranded wrangler store on the pass that may change something', async () => {
    const store = path.join(scratch, 'apps', 'api', '.wrangler', 'state', 'v3');
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, 'left-behind.sqlite'), 'held');

    await auditOver({ ...worldOf([]), probeStore: () => ok({ kind: 'vacant' }) }, 'housekeeping');

    await expect(readdir(store)).resolves.toEqual([]);
  });

  it('drops one the next pass reclaims from what a bring-up asks a human to do', async () => {
    const run = await auditOver(
      worldOf([createdAgo(UNOWNED_RECLAIM_AFTER_MS + HOUR_MS)]),
      'housekeeping'
    );

    expect(containerLine(run)).toBeUndefined();
  });

  it('still asks a human to remove a container that has not stood that long', async () => {
    const run = await auditOver(worldOf([createdAgo(UNOWNED_RECLAIM_AFTER_MS - HOUR_MS)]));

    expect(containerLine(run)).toContain('remove it by hand');
  });

  it('says how long a container has stood could not be read rather than implying it is fresh', async () => {
    const run = await auditOver(worldOf([{ name: EMULATOR, createdAt: '' }]));

    expect(containerLine(run)).toContain('the listing carried no creation time for it');
  });

  it('leaves every other class printing what it printed before a container carried an age', async () => {
    const run = await auditOver(everyOtherClass());

    expect(run.messages).toEqual([
      'stuck-container hushbox-stack-web-1 (docker has it exited) — unowned — no claim — a ' +
        'compose project\u2019s containers are not recorded one by one, so nothing here can say ' +
        'which bring-up left this one behind — remove it by hand once you have confirmed the ' +
        'project it belongs to is not using it — `pnpm docker:cleanup` reclaims only a container ' +
        'no compose project owns, and a teardown reaches this one only by taking the whole ' +
        'project down',
      'stage-database hushbox_run_left_behind — unowned — no claim — its name carries no run, ' +
        'and nothing recorded it, so nothing here can say which build staged it — remove it by ' +
        'hand once you have confirmed no build is filling it — nothing reclaims a staging ' +
        'database no claim names',
      'bucket hushbox-scratch-left-behind — unowned — no claim — nothing recorded it, which is ' +
        'what a process that held no run claim leaves behind, so nothing here can say what ' +
        'created it — remove it by hand once you have confirmed it is yours — `pnpm test` ' +
        'reclaims one whose run recorded it, and nothing reclaims one no claim names',
      `port ${String(UNBANDED_PORT)} — unowned — no claim — nothing recorded it, which is what ` +
        'a process that held no run claim leaves behind, so nothing here can say what created ' +
        'it — remove it by hand once you have confirmed it is yours — `pnpm dev:clean` reclaims ' +
        'one whose run recorded it, and only `pnpm dev:clean --unowned` ends one no claim names',
      `socket ${path.join(scratch, 'spawner.sock')} (the socket a spawning process answers its ` +
        'children on) — unowned — no claim — nothing recorded it, which is what a process that ' +
        'held no run claim leaves behind, so nothing here can say what created it — `pnpm ' +
        'dev:clean` attempts the removal — no claim names it and a connect to it was refused, ' +
        'so there is nothing behind the file to strand, and an unlink the operating system ' +
        'refuses is reported by the pass that made it',
      '4 resource(s) a human must act on. Each line ends with the repair for that one; until ' +
        'it is applied, nothing reclaims it.',
    ]);
  });
});
