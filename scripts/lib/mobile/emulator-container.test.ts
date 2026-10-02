import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { composeProjectName } from '../cli/worktree.js';
import { recordOwnedResource } from '../claims/ownership.js';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { portFor } from '../stack/port-plan.js';
import { emulatorContainerName, removeEmulatorContainer } from './emulator-container.js';

const mockExeca = vi.mocked(execa);

/** A checkout path the registry records; nothing reads through it. */
const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

/**
 * The run claim this file was invoked under. Registering a run inside a case
 * clears the variable on the way out, so a hook that puts back an empty string
 * leaves every later suite here — and everything else this worker goes on to
 * run — creating resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

afterAll(() => {
  // Empty string rather than absent: every reader treats an empty claim
  // variable as no claim, and a computed key cannot be deleted.
  expect(process.env[RUN_CLAIM_ENV]).toBe(inheritedRunClaim ?? '');
});

describe('emulatorContainerName', () => {
  it('gives two slots different names for the same shard', () => {
    expect(emulatorContainerName(3, 0)).not.toBe(emulatorContainerName(7, 0));
  });

  it('scopes the name to the slot the port of that shard is allocated from', () => {
    // Port and name are two derivations of one pair. Naming after the slot's
    // compose project is what keeps them the same derivation rather than two
    // that agree by inspection.
    for (const slot of [0, 3, 7]) {
      expect(emulatorContainerName(slot, 0).startsWith(composeProjectName(slot))).toBe(true);
      expect(portFor('emulatorAdb', { slot, mode: 'development', lane: 0 })).not.toBe(
        portFor('emulatorAdb', { slot: slot + 1, mode: 'development', lane: 0 })
      );
    }
  });

  it('gives two shards of one slot different names', () => {
    expect(emulatorContainerName(3, 0)).not.toBe(emulatorContainerName(3, 1));
  });

  it('keeps the prefix the container reclaimer scans for', () => {
    expect(emulatorContainerName(3, 0).startsWith('hushbox-')).toBe(true);
  });
});

describe('removeEmulatorContainer', () => {
  const NAME = 'hushbox-4-emulator-shard-0';
  let registryDir: string;
  let present: string[];

  /** Stands in for the world: which containers `docker ps` finds under that name. */
  function dockerWorld(): void {
    mockExeca.mockImplementation(((command: string, args?: readonly string[]) => {
      const argumentList = Array.isArray(args) ? args : [];
      if (command === 'docker' && argumentList[0] === 'ps') {
        const wanted = argumentList.find((a) => a.startsWith('name='))?.slice('name='.length) ?? '';
        const name = wanted.replaceAll('^', '').replaceAll('$', '');
        return Promise.resolve({ stdout: present.includes(name) ? name : '', exitCode: 0 });
      }
      if (command === 'docker' && argumentList[0] === 'rm') {
        present = present.filter((n) => n !== argumentList[2]);
        return Promise.resolve({ stdout: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', exitCode: 0 });
    }) as never);
  }

  function removals(): string[][] {
    return mockExeca.mock.calls
      .filter((call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'rm')
      .map((call) => [...(call[1] as string[])]);
  }

  function run<T>(command: string, body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command, mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  /** Registers a second run in this process, which needs the first one's token cleared. */
  function inSecondRun<T>(command: string, body: () => Promise<T>): Promise<T> {
    process.env[RUN_CLAIM_ENV] = '';
    return run(command, body);
  }

  /**
   * Makes the enclosing run's record unreadable in the form that needs no
   * corruption: a record a wider checkout wrote names a mode this one has never
   * heard of. The run behind it goes on holding its lock.
   */
  async function damageOwnRecord(): Promise<void> {
    const record = path.join(process.env[RUN_CLAIM_ENV] ?? '', 'run.json');
    const written: unknown = JSON.parse(await readFile(record, 'utf8'));
    await writeFile(
      record,
      JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
    );
  }

  /** A run that died holding the container: its record stands, its lock does not. */
  async function runThatDiedHolding(name: string): Promise<void> {
    await expect(
      run('pnpm mobile:test', async () => {
        await recordOwnedResource('container', name);
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    // The invocation running this suite is itself a registered run and stamps
    // its directory into the environment every child inherits. Left in place,
    // `registerRun` adopts that run instead of registering in the scratch
    // registry, and the cases below read the machine-wide registry.
    process.env[RUN_CLAIM_ENV] = '';
    registryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hushbox-emulator-')));
    present = [];
    dockerWorld();
  });

  afterEach(async () => {
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    vi.restoreAllMocks();
    await rm(registryDir, { recursive: true, force: true });
  });

  it('removes nothing when no container carries the name', async () => {
    const outcome = await removeEmulatorContainer({ name: NAME, registryDir });

    expect(outcome.verdict).toBe('absent');
    expect(outcome.removed).toBe(false);
    expect(removals()).toEqual([]);
  });

  it('removes a container whose owning run is gone', async () => {
    present = [NAME];
    await runThatDiedHolding(NAME);

    const outcome = await removeEmulatorContainer({ name: NAME, registryDir });

    expect(outcome.verdict).toBe('expired');
    expect(outcome.removed).toBe(true);
    expect(removals()).toEqual([['rm', '-f', NAME]]);
  });

  it('removes the container the asking run recorded itself', async () => {
    present = [NAME];

    const outcome = await run('pnpm mobile:test', async () => {
      await recordOwnedResource('container', NAME);
      return removeEmulatorContainer({ name: NAME, registryDir });
    });

    expect(outcome.verdict).toBe('own');
    expect(outcome.removed).toBe(true);
  });

  it('leaves a container another live run recorded', async () => {
    present = [NAME];

    const outcome = await run('pnpm mobile:test', async () => {
      await recordOwnedResource('container', NAME);
      return inSecondRun('pnpm mobile:test', () =>
        removeEmulatorContainer({ name: NAME, registryDir })
      );
    });

    expect(outcome.verdict).toBe('held');
    expect(outcome.removed).toBe(false);
    expect(removals()).toEqual([]);
  });

  it('names the run holding it, so the line says whose work was spared', async () => {
    present = [NAME];

    const outcome = await run('pnpm mobile:test', async () => {
      await recordOwnedResource('container', NAME);
      return inSecondRun('pnpm mobile:test', () =>
        removeEmulatorContainer({ name: NAME, registryDir })
      );
    });

    expect(outcome.spared).toContain(NAME);
  });

  it('leaves a container no claim names', async () => {
    present = [NAME];

    const outcome = await removeEmulatorContainer({ name: NAME, registryDir });

    expect(outcome.verdict).toBe('unowned');
    expect(outcome.removed).toBe(false);
    expect(removals()).toEqual([]);
  });

  it('leaves a reclaimable container while a live run’s record cannot be read', async () => {
    present = [NAME];
    await runThatDiedHolding(NAME);

    const outcome = await run('pnpm dev', async () => {
      await damageOwnRecord();
      return inSecondRun('pnpm mobile:test', () =>
        removeEmulatorContainer({ name: NAME, registryDir })
      );
    });

    expect(outcome.verdict).toBe('unknown');
    expect(outcome.removed).toBe(false);
    expect(removals()).toEqual([]);
  });

  it('still removes its own container while a live run’s record cannot be read', async () => {
    present = [NAME];

    const outcome = await run('pnpm dev', async () => {
      await damageOwnRecord();
      return inSecondRun('pnpm mobile:test', async () => {
        await recordOwnedResource('container', NAME);
        return removeEmulatorContainer({ name: NAME, registryDir });
      });
    });

    expect(outcome.verdict).toBe('own');
    expect(outcome.removed).toBe(true);
  });

  it('reclaims again once the run behind the unreadable record has gone', async () => {
    present = [NAME];
    await runThatDiedHolding(NAME);
    await run('pnpm dev', damageOwnRecord);

    const outcome = await removeEmulatorContainer({ name: NAME, registryDir });

    expect(outcome.verdict).toBe('expired');
    expect(outcome.removed).toBe(true);
  });

  it('asks docker for the exact name rather than a prefix of it', async () => {
    await removeEmulatorContainer({ name: NAME, registryDir });

    const probe = mockExeca.mock.calls.find(
      (call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'ps'
    );
    expect(probe?.[1]).toContain(`name=^${NAME}$`);
  });
});
