import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containersThisRunRecorded } from './owned-containers.js';
import { recordOwnedResource } from './ownership.js';
import { RUN_CLAIM_ENV, registerRun } from './registry.js';

const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

/**
 * The run claim this file was invoked under. The cases below clear it, and a
 * hook that put back an empty string instead would leave every later suite this
 * worker runs creating resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

describe('containersThisRunRecorded', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hushbox-own-container-')));
    process.env[RUN_CLAIM_ENV] = '';
  });

  afterEach(async () => {
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
  });

  function run<T>(command: string, body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command, mode: 'test', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  it('names the container this run recorded and no resource of another kind', async () => {
    await run('pnpm test', async () => {
      await recordOwnedResource('container', 'hushbox-drill-mine');
      await recordOwnedResource('database', 'hb_t_mine_w1');

      await expect(containersThisRunRecorded(registryDir)).resolves.toStrictEqual([
        'hushbox-drill-mine',
      ]);
    });
  });

  /**
   * A second run in one process cannot be registered — a process that inherited
   * a claim adopts it — so the other run here is one that ended, which is the
   * state its record survives in. What is compared is the run the record names,
   * and that comparison is the same whichever state the record is in.
   */
  it("leaves out a container another run's record names", async () => {
    await expect(
      run('pnpm test', async () => {
        await recordOwnedResource('container', 'hushbox-drill-theirs');
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');

    await run('pnpm test', async () => {
      await expect(containersThisRunRecorded(registryDir)).resolves.toStrictEqual([]);
    });
  });

  /**
   * The answer for a process holding no claim would be "none" whatever exists,
   * which reads as a clean sheet, and a check resting on it passes while
   * proving nothing.
   */
  it('refuses to answer for a process that holds no run claim', async () => {
    await expect(containersThisRunRecorded(registryDir)).rejects.toThrow(/no run claim/);
  });
});
