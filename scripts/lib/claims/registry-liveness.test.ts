import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tryLock } from './claim.js';
import { readOwnership } from './ownership.js';
import {
  RUN_CLAIM_ENV,
  enumerateClaims,
  lockPathFor,
  readSlotLiveness,
  registerRun,
} from './registry.js';
import type { Readable, Writable } from 'node:stream';

/**
 * A claim's state is a kernel fact about a process, so only real processes can
 * produce the three states this asserts. The run runs through tsx's loader
 * in-process (`--import`) rather than through its CLI, which forks: a signal
 * has to reach the process that actually holds the lock.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RUN_ENTRY = fileURLToPath(new URL('registry-run-entry.mjs', import.meta.url));

/** What `spawn` returns for the fixture's `['pipe', 'pipe', 'inherit']` streams. */
type RunProcess = ChildProcessByStdio<Writable, Readable, null>;

let registryDir: string;
let runs: RunProcess[];

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

interface Run {
  readonly child: RunProcess;
  /** The run id the other process registered. */
  readonly runId: string;
  release(): Promise<void>;
}

/** Starts a run in another process and resolves once it has registered. */
async function startRun(
  options: {
    readonly command?: string;
    readonly slot?: number;
    readonly ending?: 'hold' | 'exit';
    readonly resources?: readonly string[];
  } = {}
): Promise<Run> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      RUN_ENTRY,
      registryDir,
      options.command ?? 'pnpm dev',
      'development',
      String(options.slot ?? 0),
      path.join(registryDir, 'checkout', '.git'),
      options.ending ?? 'hold',
      ...(options.resources ?? []),
    ],
    { env: { ...process.env }, stdio: ['pipe', 'pipe', 'inherit'] }
  );
  runs.push(child);

  const runId = await new Promise<string>((resolve, reject) => {
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
    runId,
    async release(): Promise<void> {
      child.stdin.write('go\n');
      await waitForExit(child);
    },
  };
}

/**
 * The run claim this file was invoked under. It is cleared before every case
 * below, and a hook that puts back an empty string instead leaves every later
 * suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

beforeEach(async () => {
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-registry-live-'));
  runs = [];
  process.env[RUN_CLAIM_ENV] = '';
});

afterEach(async () => {
  // Ahead of the cleanup, because a cleanup that throws would otherwise skip it
  // and leave the worker without the claim this file was handed. Empty string
  // rather than absent: every reader treats an empty claim variable as no
  // claim, and a computed key cannot be deleted.
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  for (const child of runs) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
  await fs.rm(registryDir, { recursive: true, force: true });
});

describe('a run in another process', () => {
  it('is owned-live while it holds its claim', async () => {
    const run = await startRun();

    const claims = await enumerateClaims(registryDir);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ state: 'owned-live', claim: { runId: run.runId } });
  });

  it('is owned-expired once it is killed', async () => {
    const run = await startRun();

    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    const claims = await enumerateClaims(registryDir);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ state: 'owned-expired', claim: { runId: run.runId } });
  });

  it('still owns the resources it recorded once it is killed', async () => {
    const run = await startRun({ resources: ['10042'] });

    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    const ownership = await readOwnership(registryDir);
    expect(ownership.stateOfResource('port', '10042')).toBe('owned-expired');
    expect(ownership.resourceOwner('port', '10042')).toMatchObject({ runId: run.runId });
  });

  it('no longer holds its slot once it is killed', async () => {
    const run = await startRun({ slot: 5 });

    run.child.kill('SIGKILL');
    await waitForExit(run.child);

    await expect(readSlotLiveness(5, registryDir)).resolves.toEqual({ claimed: [], unknown: [] });
  });

  it('holds its slot against every other checkout while it lives', async () => {
    await startRun({ slot: 5 });

    const { claimed } = await readSlotLiveness(5, registryDir);

    expect(claimed).toHaveLength(1);
  });
});

describe('the file a released claim leaves behind', () => {
  it('outlives the run that held it, still naming that run', async () => {
    const run = await startRun({ command: 'pnpm build', resources: ['10042'] });
    await run.release();

    // The name is the file's first line, and the assertion is on that line
    // rather than on the file containing it: the primitive never shortens the
    // file, so a longer predecessor's remains sit past the name, and a
    // containment check would pass on a file whose first line is something
    // else entirely.
    const left = await fs.readFile(lockPathFor(registryDir, run.runId), 'utf8');
    expect(left.split('\n')[0]).toBe('pnpm build');
  });

  it('is not a claim: the run that released it owns nothing', async () => {
    const run = await startRun({ resources: ['10042'] });
    await run.release();

    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
    const ownership = await readOwnership(registryDir);
    expect(ownership.stateOfResource('port', '10042')).toBe('unowned');
  });

  it('reads as free the instant its holder is gone', async () => {
    const run = await startRun();
    await run.release();

    await expect(tryLock(lockPathFor(registryDir, run.runId))).resolves.toEqual({
      held: false,
      holder: null,
    });
  });
});

describe('runs registering at the same time', () => {
  it('loses none of them', async () => {
    const started = await Promise.all(
      Array.from({ length: 8 }, (_, index) => startRun({ resources: [String(10_000 + index)] }))
    );

    const claims = await enumerateClaims(registryDir);

    expect(new Set(claims.map((found) => found.claim.runId))).toEqual(
      new Set(started.map((run) => run.runId))
    );
  });

  it('loses no resource when children record against one inherited run at once', async () => {
    let resources: readonly { id: string }[] = [];

    await registerRun(
      {
        command: 'pnpm dev',
        mode: 'development',
        slot: 0,
        gitCommonDir: path.join(registryDir, 'checkout', '.git'),
        registryDir,
      },
      async () => {
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            startRun({ ending: 'exit', resources: [String(11_000 + index)] })
          )
        );
        const [found] = await enumerateClaims(registryDir);
        resources = found?.claim.resources ?? [];
      }
    );

    expect(resources.map((held) => held.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
      Array.from({ length: 8 }, (_, index) => String(11_000 + index))
    );
  });
});

describe('classifying a world of real runs', () => {
  it('reports owned-live, owned-expired and unowned side by side', async () => {
    const live = await startRun({ command: 'pnpm dev', resources: ['10001'] });
    const killed = await startRun({ command: 'pnpm e2e', slot: 1, resources: ['10002'] });
    killed.child.kill('SIGKILL');
    await waitForExit(killed.child);

    const ownership = await readOwnership(registryDir);

    expect(['10001', '10002', '10003'].map((id) => ownership.stateOfResource('port', id))).toEqual([
      'owned-live',
      'owned-expired',
      'unowned',
    ]);
    expect(ownership.resourceOwner('port', '10001')).toMatchObject({ runId: live.runId });
    expect(ownership.resourceOwner('port', '10002')).toMatchObject({ runId: killed.runId });
    expect(ownership.resourceOwner('port', '10003')).toBeUndefined();
  });
});
