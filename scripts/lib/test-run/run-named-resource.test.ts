import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { currentRunId, readOwnership, recordOwnedResource } from '../claims/ownership.js';
import { stateOfRunNamedResource } from './run-named-resource.js';

const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

/**
 * The run claim this file was invoked under. Registering a run inside a case
 * clears the variable on the way out, so a hook that puts back an empty string
 * leaves every later suite here — and everything else this worker goes on to
 * run — creating resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

describe('stateOfRunNamedResource', () => {
  let registryDir = '';

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-run-named-'));
    process.env[RUN_CLAIM_ENV] = '';
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  afterAll(() => {
    // Empty string rather than removed: every reader treats an empty claim
    // variable as no claim, and a computed key cannot be deleted.
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  });

  function run<T>(body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command: 'pnpm test', mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  it('answers from the record while the run that wrote it is still alive', async () => {
    await run(async () => {
      await recordOwnedResource('database', 'hb_t_prefix_w');
      const ownership = await readOwnership(registryDir);

      expect(stateOfRunNamedResource(ownership, 'database', 'hb_t_prefix_w')).toBe('owned-live');
    });
  });

  it('answers from the record of a run that died holding it', async () => {
    await expect(
      run(async () => {
        await recordOwnedResource('database', 'hb_t_prefix_w');
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');
    const ownership = await readOwnership(registryDir);

    expect(stateOfRunNamedResource(ownership, 'database', 'hb_t_prefix_w')).toBe('owned-expired');
  });

  it('answers from the name once the record went with the run that ended', async () => {
    const ended = await run(() => Promise.resolve(currentRunId() ?? ''));
    const ownership = await readOwnership(registryDir);

    expect(stateOfRunNamedResource(ownership, 'database', 'hb_t_prefix_w', ended)).toBe(
      'owned-expired'
    );
  });

  it('leaves a resource of a run neither the record nor the name accounts for unowned', async () => {
    const ownership = await readOwnership(registryDir);

    expect(
      stateOfRunNamedResource(ownership, 'bucket', 'hushbox-scratch-stranger-', 'a-foreign-run')
    ).toBe('unowned');
  });

  it('keeps a live run whose resource is named in the older spelling out of reclamation', async () => {
    await run(async () => {
      // The name carries a token no run id could produce, so only the record can
      // attribute it — which is why the record is read first.
      await recordOwnedResource('bucket', 'hushbox-scratch-ab12cd34ef-');
      const ownership = await readOwnership(registryDir);

      expect(stateOfRunNamedResource(ownership, 'bucket', 'hushbox-scratch-ab12cd34ef-')).toBe(
        'owned-live'
      );
    });
  });
});
