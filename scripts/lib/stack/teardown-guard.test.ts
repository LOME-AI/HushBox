import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentRunId } from '../claims/ownership.js';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { assertSlotFreeToTearDown, otherRunsOnSlot } from './teardown-guard.js';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * A claim is live only while a process holds its lock, so a run standing in the
 * way of a teardown has to be a real one. It runs through tsx's loader
 * in-process (`--import`) rather than through the CLI, which forks: the lock
 * must belong to the process the test can end.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RUN_ENTRY = fileURLToPath(new URL('../claims/registry-run-entry.mjs', import.meta.url));

const SLOT = 5;

let registryDir = '';
let workDir = '';
const foreignRuns: ChildProcessByStdio<Writable, Readable, null>[] = [];

beforeEach(() => {
  registryDir = mkdtempSync(path.join(tmpdir(), 'hb-teardown-claims-'));
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-teardown-work-'));
  // Emptied so `registerRun` below takes a claim of its own in this registry
  // rather than adopting whatever run the test suite itself is wrapped in —
  // an adopted run writes no record here, and every assertion about the run
  // this process belongs to would pass against an empty registry.
  vi.stubEnv(RUN_CLAIM_ENV, '');
});

afterEach(() => {
  for (const child of foreignRuns) child.kill();
  foreignRuns.length = 0;
  vi.unstubAllEnvs();
  rmSync(registryDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

interface ForeignRun {
  /** The directory its record lives in, which is also the whole of what names it. */
  readonly runId: string;
  release(): Promise<void>;
}

/** Registers a run on this slot in another process and holds it until released. */
async function startForeignRun(command: string, slot: number = SLOT): Promise<ForeignRun> {
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      RUN_ENTRY,
      registryDir,
      command,
      'development',
      String(slot),
      workDir,
      'hold',
    ],
    {
      env: { ...process.env, [RUN_CLAIM_ENV]: '' },
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  );
  foreignRuns.push(child);

  const runId = await new Promise<string>((resolve) => {
    child.stdout.once('data', (chunk: Buffer) => {
      resolve(chunk.toString('utf8').trim());
    });
  });

  return {
    runId,
    release: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        child.stdin.write('go\n');
      }),
  };
}

/**
 * A record a wider checkout wrote is invalid to a narrower reader, so this needs
 * no corruption and no crash: two checkouts of different ages on one machine
 * reach it in ordinary use.
 */
function damageRecordOf(run: ForeignRun): void {
  const record = path.join(registryDir, run.runId, 'run.json');
  const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
  writeFileSync(
    record,
    JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
  );
}

/** Runs `body` inside a run claim of this process's own, as a wrapped command holds one. */
function asOwnRun<T>(body: () => Promise<T>): Promise<T> {
  return registerRun(
    {
      command: 'pnpm db:down',
      mode: 'development',
      slot: SLOT,
      gitCommonDir: workDir,
      registryDir,
    },
    body
  );
}

describe('otherRunsOnSlot', () => {
  it('leaves out the run it is told to disregard', async () => {
    await asOwnRun(async () => {
      const others = await otherRunsOnSlot(SLOT, currentRunId(), registryDir);

      expect(others.claimed).toEqual([]);
    });
  });

  it('counts that same run when it is told to disregard nobody', async () => {
    await asOwnRun(async () => {
      const others = await otherRunsOnSlot(SLOT, null, registryDir);

      expect(others.claimed.map((found) => found.command)).toEqual(['pnpm db:down']);
    });
  });

  it('keeps a run that is not the one it was told to disregard', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    try {
      await asOwnRun(async () => {
        const others = await otherRunsOnSlot(SLOT, currentRunId(), registryDir);

        expect(others.claimed.map((found) => found.command)).toEqual(['pnpm test:pkg']);
      });
    } finally {
      await other.release();
    }
  });

  it('keeps a live run whose record could not be read', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    damageRecordOf(other);
    try {
      const others = await otherRunsOnSlot(SLOT, null, registryDir);

      expect(others.unknown.map((found) => found.runId)).toEqual([other.runId]);
    } finally {
      await other.release();
    }
  });

  it('leaves out a run on another slot', async () => {
    const other = await startForeignRun('pnpm test:pkg', SLOT + 1);
    try {
      const others = await otherRunsOnSlot(SLOT, null, registryDir);

      expect(others.claimed).toEqual([]);
    } finally {
      await other.release();
    }
  });
});

describe('assertSlotFreeToTearDown', () => {
  it('does not refuse on the claim of the run it is running inside', async () => {
    await expect(
      asOwnRun(() => assertSlotFreeToTearDown(SLOT, registryDir))
    ).resolves.toBeUndefined();
  });

  it('refuses from inside a run of its own when another run holds the slot', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    try {
      await expect(asOwnRun(() => assertSlotFreeToTearDown(SLOT, registryDir))).rejects.toThrow(
        'pnpm test:pkg'
      );
    } finally {
      await other.release();
    }
  });

  it('proceeds when nothing is live on the slot', async () => {
    await expect(assertSlotFreeToTearDown(SLOT, registryDir)).resolves.toBeUndefined();
  });

  it('names the slot it is refusing to tear down', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    try {
      await expect(assertSlotFreeToTearDown(SLOT, registryDir)).rejects.toThrow(
        `refusing to tear down slot ${String(SLOT)}`
      );
    } finally {
      await other.release();
    }
  });

  it('names every live run when more than one is in the way', async () => {
    const one = await startForeignRun('pnpm test:pkg');
    const two = await startForeignRun('pnpm e2e');
    try {
      // Named without ordering: the registry is a directory of runs, so which
      // of two live claims is read first is not a property of anything.
      const failure = await assertSlotFreeToTearDown(SLOT, registryDir).then(
        () => 'the teardown was not refused at all',
        String
      );

      expect(failure).toContain('pnpm test:pkg');
      expect(failure).toContain('pnpm e2e');
      expect(failure).toContain('are still live on it');
    } finally {
      await one.release();
      await two.release();
    }
  });

  it('tells the operator what to do next', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    try {
      await expect(assertSlotFreeToTearDown(SLOT, registryDir)).rejects.toThrow(
        'Re-run once they have finished'
      );
    } finally {
      await other.release();
    }
  });

  it('describes the blast radius a teardown has, not the wipe’s', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    try {
      const failure = await assertSlotFreeToTearDown(SLOT, registryDir).then(
        () => 'the teardown was not refused at all',
        String
      );

      expect(failure).toContain('removes the containers and networks on the slot');
      expect(failure).toContain('The named volumes survive');
    } finally {
      await other.release();
    }
  });

  it('refuses while a live run’s record could not be read, naming the run to go and look at', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    damageRecordOf(other);
    try {
      await expect(assertSlotFreeToTearDown(SLOT, registryDir)).rejects.toThrow(other.runId);
    } finally {
      await other.release();
    }
  });

  it('says what to do about a record nothing could read', async () => {
    const other = await startForeignRun('pnpm test:pkg');
    damageRecordOf(other);
    try {
      await expect(assertSlotFreeToTearDown(SLOT, registryDir)).rejects.toThrow(
        'remove its directory by hand'
      );
    } finally {
      await other.release();
    }
  });

  it('leaves another slot’s runs out of it', async () => {
    const other = await startForeignRun('pnpm test:pkg', SLOT + 1);
    try {
      await expect(assertSlotFreeToTearDown(SLOT, registryDir)).resolves.toBeUndefined();
    } finally {
      await other.release();
    }
  });
});
