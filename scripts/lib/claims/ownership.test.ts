import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RUN_CLAIM_ENV, registerRun } from './registry.js';
import {
  currentRunId,
  readOwnership,
  reapPass,
  recordOwnedResource,
  recordOwnedResourceIfClaimed,
  unownedFinding,
} from './ownership.js';

const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

/**
 * The run claim this file was invoked under. The suites below clear it before
 * every case, and a hook that puts back an empty string instead leaves every
 * later suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

describe('ownership over a real registry', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hushbox-ownership-')));
    process.env[RUN_CLAIM_ENV] = '';
  });

  afterEach(async () => {
    // Empty string rather than absent: every reader treats an empty claim
    // variable as no claim, and a computed key cannot be deleted.
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
  });

  function run<T>(command: string, body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command, mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  it('reports a resource of a run still holding its claim as owned-live', async () => {
    await run('pnpm test', async () => {
      await recordOwnedResource('database', 'hb_t_alive_w1');
      const ownership = await readOwnership(registryDir);

      expect(ownership.stateOfResource('database', 'hb_t_alive_w1')).toBe('owned-live');
    });
  });

  it('reports a resource of a run that died as owned-expired', async () => {
    await expect(
      run('pnpm test', async () => {
        await recordOwnedResource('database', 'hb_t_dead_w1');
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');

    const ownership = await readOwnership(registryDir);

    expect(ownership.stateOfResource('database', 'hb_t_dead_w1')).toBe('owned-expired');
  });

  /**
   * A directory is the one resource kind whose id is a path, and a directory
   * reached through a symlink has two absolute spellings. Recorded under one
   * and asked about under the other, a live run's working set would read as
   * owned by nobody — which is the verdict that licenses deleting it.
   */
  it('answers for a directory recorded through a link when asked about its real path', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hushbox-owned-dir-')));
    await mkdir(path.join(root, 'real', 'generation'), { recursive: true });
    await symlink(path.join(root, 'real'), path.join(root, 'link'), 'dir');

    try {
      await run('pnpm test', async () => {
        await recordOwnedResource('directory', path.join(root, 'link', 'generation'));
        const ownership = await readOwnership(registryDir);

        expect(ownership.stateOfResource('directory', path.join(root, 'real', 'generation'))).toBe(
          'owned-live'
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a resource no claim carries as unowned', async () => {
    const ownership = await readOwnership(registryDir);

    expect(ownership.stateOfResource('database', 'hb_t_stranger_w1')).toBe('unowned');
  });

  it('names the owning run so a report line can attribute the resource', async () => {
    await expect(
      run('pnpm e2e', async () => {
        await recordOwnedResource('container', 'hushbox-emulator');
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');

    const ownership = await readOwnership(registryDir);

    expect(ownership.resourceOwner('container', 'hushbox-emulator')?.command).toBe('pnpm e2e');
  });

  it('distinguishes two resources of the same id under different kinds', async () => {
    await run('pnpm test', async () => {
      await recordOwnedResource('bucket', 'shared-name');
      const ownership = await readOwnership(registryDir);

      expect(ownership.stateOfResource('bucket', 'shared-name')).toBe('owned-live');
      expect(ownership.stateOfResource('database', 'shared-name')).toBe('unowned');
    });
  });

  it('answers by run id, so a resource named after its owner can be attributed', async () => {
    await run('pnpm test', async () => {
      const runId = currentRunId();
      const ownership = await readOwnership(registryDir);

      expect(runId).not.toBeNull();
      expect(ownership.stateOfRun(runId)).toBe('owned-live');
    });
  });

  it('lets the run still alive answer for an id a dead run also named', async () => {
    await expect(
      run('pnpm test', async () => {
        await recordOwnedResource('port', '10404');
        throw new Error('killed');
      })
    ).rejects.toThrow('killed');

    await run('pnpm dev', async () => {
      await recordOwnedResource('port', '10404');
      const ownership = await readOwnership(registryDir);

      expect(ownership.stateOfResource('port', '10404')).toBe('owned-live');
      expect(ownership.resourceOwner('port', '10404')?.command).toBe('pnpm dev');
    });
  });

  it('has no owner to name for a resource no claim carries', async () => {
    const ownership = await readOwnership(registryDir);

    expect(ownership.resourceOwner('port', '10404')).toBeUndefined();
  });

  it('reclaims a resource of a run whose record went with its clean exit', async () => {
    let ended: string | null = null;

    await run('pnpm test', () => {
      ended = currentRunId();
      return Promise.resolve();
    });

    const ownership = await readOwnership(registryDir);

    expect(ended).not.toBeNull();
    expect(ownership.stateOfRun(ended)).toBe('owned-expired');
  });

  it('keeps a run alive in the answer while it still holds its claim', async () => {
    await run('pnpm test', async () => {
      const ownership = await readOwnership(registryDir);

      expect(ownership.stateOfRun(currentRunId())).toBe('owned-live');
    });
  });

  it('answers unowned for a run id the registry never held', async () => {
    const ownership = await readOwnership(registryDir);

    expect(ownership.stateOfRun('a-run-that-never-registered')).toBe('unowned');
  });

  it('answers unowned when the resource carries no owner at all', async () => {
    const ownership = await readOwnership(registryDir);
    const noOwner: string | undefined = process.env['HB_A_VARIABLE_NOTHING_SETS'];

    expect(ownership.stateOfRun(noOwner)).toBe('unowned');
  });
});

describe('the wording a pass leaves a resource standing under', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hushbox-finding-')));
    process.env[RUN_CLAIM_ENV] = '';
  });

  afterEach(async () => {
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
  });

  it('states the finding when every record was read', async () => {
    const ownership = await readOwnership(registryDir);

    expect(unownedFinding(ownership)).toContain('no claim, live or expired');
  });

  it('names the run to go and look at when one live record could not be read', async () => {
    let finding = '';

    await registerRun(
      { command: 'pnpm test', mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      async () => {
        const runDir = process.env[RUN_CLAIM_ENV] ?? '';
        await writeFile(path.join(runDir, 'run.json'), '{ not json');
        finding = unownedFinding(await readOwnership(registryDir));
      }
    );

    expect(finding).toContain('could not be read');
    expect(finding).toContain('left standing');
  });
});

describe('recording against the enclosing run', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hushbox-ownership-')));
    process.env[RUN_CLAIM_ENV] = '';
  });

  afterEach(async () => {
    // Empty string rather than absent: every reader treats an empty claim
    // variable as no claim, and a computed key cannot be deleted.
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
  });

  function run<T>(body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command: 'pnpm test', mode: 'development', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  it('refuses to record when this process holds no run claim', async () => {
    await expect(recordOwnedResource('database', 'hb_t_x_w1')).rejects.toThrow(/registerRun/);
  });

  it('names the kind and the id it had nothing to record against', async () => {
    await expect(recordOwnedResource('database', 'hb_t_x_w1')).rejects.toThrow(
      /database.*hb_t_x_w1/
    );
  });

  it('has no run id when this process holds no run claim', () => {
    expect(currentRunId()).toBeNull();
  });

  it('records against the run when one is held', async () => {
    await run(async () => {
      await recordOwnedResource('database', 'hb_t_x_w1');
      const ownership = await readOwnership(registryDir);

      expect(ownership.stateOfResource('database', 'hb_t_x_w1')).toBe('owned-live');
    });
  });

  it('answers nothing at all, so a recording cannot be read as a verdict', async () => {
    await run(async () => {
      await expect(recordOwnedResource('database', 'hb_t_x_w1')).resolves.toBeUndefined();
    });
  });

  it('reports a skip to a caller another mechanism accounts for, holding no claim', async () => {
    await expect(recordOwnedResourceIfClaimed('database', 'hb_t_x_w1')).resolves.toBe(false);
  });

  it('writes no entry for a caller another mechanism accounts for, holding no claim', async () => {
    await recordOwnedResourceIfClaimed('database', 'hb_t_x_w1');

    await expect(readdir(registryDir)).resolves.toEqual([]);
  });

  it('records for a caller another mechanism accounts for once it holds a claim', async () => {
    await run(async () => {
      await recordOwnedResourceIfClaimed('database', 'hb_t_x_w1');
      const ownership = await readOwnership(registryDir);

      expect(ownership.stateOfResource('database', 'hb_t_x_w1')).toBe('owned-live');
    });
  });

  it('reports the recording it made to a caller another mechanism accounts for', async () => {
    await run(async () => {
      await expect(recordOwnedResourceIfClaimed('database', 'hb_t_x_w1')).resolves.toBe(true);
    });
  });
});

describe('the changes-detected guard', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-ownership-'));
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  it('reaps what a settled scan found', async () => {
    const reaped = await reapPass({
      registryDir,
      what: 'test resources',
      scan: () => Promise.resolve(['one', 'two']),
      reap: (present) => Promise.resolve([...present]),
    });

    expect(reaped).toEqual(['one', 'two']);
  });

  it('retries the pass when a resource appeared while it was reading the registry', async () => {
    const scans = [['one'], ['one', 'two'], ['one', 'two'], ['one', 'two']];
    let index = 0;

    const reaped = await reapPass({
      registryDir,
      what: 'test resources',
      scan: () => Promise.resolve(scans[index++] ?? []),
      reap: (present) => Promise.resolve([...present]),
    });

    expect(reaped).toEqual(['one', 'two']);
  });

  it('tolerates a resource that disappeared, which no reaper can harm', async () => {
    const scans = [['one', 'two'], ['one']];
    let index = 0;

    const reaped = await reapPass({
      registryDir,
      what: 'test resources',
      scan: () => Promise.resolve(scans[index++] ?? []),
      reap: (present) => Promise.resolve([...present]),
    });

    expect(reaped).toEqual(['one', 'two']);
  });

  it('leaves a reading it could never settle for the next pass, without reaping', async () => {
    let created = 0;
    let reaped = false;

    const result = await reapPass({
      registryDir,
      attempts: 3,
      what: 'test resources',
      scan: () => Promise.resolve(Array.from({ length: created++ }, (_, n) => String(n))),
      reap: (present) => {
        reaped = true;
        return Promise.resolve([...present]);
      },
    });

    expect(result).toBeUndefined();
    expect(reaped).toBe(false);
  });

  it('names what it skipped, so a pass that reaped nothing is not silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let created = 0;

    await reapPass({
      registryDir,
      attempts: 3,
      what: 'test resources',
      scan: () => Promise.resolve(Array.from({ length: created++ }, (_, n) => String(n))),
      reap: (present) => Promise.resolve([...present]),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test resources'));
    warn.mockRestore();
  });
});
