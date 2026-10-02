import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURE_BOOT_BUDGET_MS, untilFileWritten, untilObserved } from '../bounded-wait.setup.js';
import { RUN_CLAIM_ENV } from './registry.js';
import { scanWorld, type StrayGroupReading, type WorldScanDeps } from './world-audit.js';
import { NO_AGE_SOURCE } from './world-scan.js';
import type { Readable, Writable } from 'node:stream';

/**
 * A run fixture registers, spawns and announces, and a case then reads the
 * machine. Every wait here is one of those, so the case is given several of the
 * one budget measured for a fixture reaching its first observable state.
 */
const CENSUS_CASE_TIMEOUT_MS = FIXTURE_BOOT_BUDGET_MS * 4;

const RUN_ENTRY = fileURLToPath(new URL('census-run-entry.mjs', import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** How the task of a run's tree stands relative to the run's own record. */
type TreeShape = 'recorded' | 'departed' | 'unrecorded';

/** The run fixture's process: its standard input is written to, its output read. */
type RunProcess = ChildProcessByStdio<Writable, Readable, null>;

interface StartedRun {
  readonly child: RunProcess;
  /** The group the run recorded, or nothing where the shape records none. */
  readonly recorded: number | undefined;
  /** The task's own process, and the one it started in a group of its own. */
  readonly task: number;
  readonly escaped: number | undefined;
}

let registryDir: string;
let reportDir: string;
let socketDir: string;
let repoRoot: string;
let runs: RunProcess[];
let started: number[];

/** Every source a pass reads, answering with nothing but the real machine's processes. */
function scan(): WorldScanDeps {
  return {
    repoRoot,
    // A scratch RAM filesystem, so the pass reads none of the machine's.
    ramHost: { platform: 'linux', parent: path.join(repoRoot, 'shm') },
    stack: { composeProject: 'hushbox-censused', checkout: repoRoot },
    containers: () => Promise.resolve([]),
    containerAges: NO_AGE_SOURCE,
    stuckContainers: () => Promise.resolve([]),
    databases: () => Promise.resolve([]),
    buckets: () => Promise.resolve([]),
    listeningPorts: () => Promise.resolve([]),
    listenerAge: NO_AGE_SOURCE,
    lifelineSockets: () => Promise.resolve([]),
    composeProjects: () =>
      Promise.resolve({
        ownerships: [],
        activeWorktreePaths: [],
        repoCommonDir: path.join(repoRoot, '.git'),
        slotOfWorktree: () => null,
      }),
  };
}

/**
 * Every stray group one pass found. The registry this pass reads is this case's
 * own and holds one run, so what comes back is that run's and nothing else.
 */
async function strayGroups(): Promise<readonly StrayGroupReading[]> {
  const world = await scanWorld(scan(), registryDir);
  expect(world.unreadable).toEqual([]);
  return world.strayGroups;
}

/** Starts a run in another process and resolves once it has registered and announced. */
async function startRun(shape: TreeShape): Promise<StartedRun> {
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, RUN_ENTRY, registryDir, reportDir, shape],
    {
      env: {
        ...process.env,
        [RUN_CLAIM_ENV]: '',
        // Each run answers its children on a socket under a directory of this
        // file's own, so a socket outlives nothing this file cannot remove.
        TMPDIR: socketDir,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
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
  const [runId, recorded] = announced.split(' ');
  // Fail where the run never registered, rather than reading a registry that
  // holds nothing and calling the empty answer a finding about the census.
  if (runId === undefined || runId === '') {
    throw new Error(`The run fixture announced no run id: ${announced}`);
  }

  const written = await untilFileWritten(path.join(reportDir, 'task'), FIXTURE_BOOT_BUDGET_MS);
  const named = written.split(' ');
  const task = Number(named[0]);
  const escaped = named[1] === undefined || named[1] === '' ? undefined : Number(named[1]);
  started.push(task);
  if (escaped !== undefined) started.push(escaped);

  return {
    child,
    recorded: recorded === undefined || recorded === '' ? undefined : Number(recorded),
    task,
    escaped,
  };
}

beforeEach(async () => {
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-census-registry-'));
  reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-census-reports-'));
  socketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-census-sockets-'));
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-census-root-'));
  runs = [];
  started = [];
});

afterEach(async () => {
  for (const child of runs) child.kill('SIGKILL');
  // Each process by its own id rather than by any group: the escaped one is
  // the whole point of the fixture and no recorded group reaches it, and the
  // task of an unrecorded tree leads no group for a group signal to address.
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is the outcome this asks for.
    }
  }
  const gone = await untilObserved(
    () =>
      started.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
    FIXTURE_BOOT_BUDGET_MS
  );
  for (const dir of [registryDir, reportDir, socketDir, repoRoot]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  if (!gone) throw new Error('A process this test started outlived the attempt to end it.');
});

/** Ends the run's own process and waits for it to go, leaving its claim expired. */
async function endRun(run: StartedRun): Promise<void> {
  run.child.kill('SIGKILL');
  const gone = await untilObserved(
    () => run.child.exitCode !== null || run.child.signalCode !== null,
    FIXTURE_BOOT_BUDGET_MS
  );
  if (!gone) throw new Error('The run fixture outlived the signal that was meant to end it.');
}

describe(
  'a census of the processes a run left in groups it never recorded',
  { timeout: CENSUS_CASE_TIMEOUT_MS },
  () => {
    it('says nothing while the run still holds its claim', async () => {
      // A live run is routinely part-way through recording a group it has just
      // detached a child into, and that child is indistinguishable from one
      // that left. Nothing here reports a neighbour's ordinary spawn.
      await startRun('departed');

      expect(await strayGroups()).toEqual([]);
    });

    it('reports nothing where every process of the tree is in the group the run recorded', async () => {
      const run = await startRun('recorded');

      await endRun(run);

      expect(await strayGroups()).toEqual([]);
    });

    it('names the group a process of the run made below the tree the run recorded', async () => {
      const run = await startRun('departed');

      await endRun(run);

      expect(await strayGroups()).toEqual([
        expect.objectContaining({ pgid: run.escaped, members: [run.escaped], origin: 'departed' }),
      ]);
    });

    it('calls a group made above the run never recorded, rather than departed', async () => {
      const run = await startRun('unrecorded');

      await endRun(run);

      expect(await strayGroups()).toEqual([expect.objectContaining({ origin: 'never-recorded' })]);
    });
  }
);
