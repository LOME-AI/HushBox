import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as atomicRename from '@hushbox/shared/atomic-rename';
import { enumerateClaims } from '../claims/registry.js';
import {
  clearTeardownFailure,
  describeTeardownFailure,
  readTeardownFailure,
  recordTeardownFailure,
  teardownFailurePath,
  teardownReason,
} from './idle-teardown-failure.js';

/**
 * Seals the directory the write is landing in and then fails. Sealing is what
 * makes the clean-up after a failed write genuinely unable to unlink, and no
 * filesystem state produces that on its own: the staging file is written while
 * the directory is still writable, and the only moment between that write and
 * the clean-up belongs to the rename.
 */
function sealTheDirectoryAndFail(): void {
  vi.spyOn(atomicRename, 'renameWithRetry').mockImplementationOnce((_from, to) => {
    chmodSync(path.dirname(to), 0o555);
    return Promise.reject(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
  });
}

let registryDir: string;

beforeEach(async () => {
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-teardown-evidence-'));
});

afterEach(async () => {
  await fs.rm(registryDir, { recursive: true, force: true });
});

describe('teardownReason', () => {
  it('answers the last thing the failing teardown said', () => {
    expect(teardownReason('pulling config\nerror: required variable is missing a value\n')).toBe(
      'error: required variable is missing a value'
    );
  });

  it('skips the blank lines a command trails its error with', () => {
    expect(teardownReason('no configuration file provided: not found\n\n  \n')).toBe(
      'no configuration file provided: not found'
    );
  });

  it('says so when the teardown failed without printing anything', () => {
    expect(teardownReason('   \n')).toBe('it printed nothing');
  });

  it('caps a runaway line rather than carrying it whole', () => {
    const reason = teardownReason('e'.repeat(400));
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith('...')).toBe(true);
  });
});

describe('the record of a teardown that could not succeed', () => {
  const failure = { consecutiveFailures: 3, exitCode: 1, reason: 'no such project' };

  it('reads back what the daemon wrote about its failing teardown', async () => {
    await recordTeardownFailure(7707, failure, registryDir);
    expect(await readTeardownFailure(7707, registryDir)).toEqual(failure);
  });

  it('reads nothing for a port whose teardown has never failed', async () => {
    expect(await readTeardownFailure(7707, registryDir)).toBeUndefined();
  });

  it('reads nothing once the failure is cleared', async () => {
    await recordTeardownFailure(7707, failure, registryDir);
    await clearTeardownFailure(7707, registryDir);
    expect(await readTeardownFailure(7707, registryDir)).toBeUndefined();
  });

  it('clears a port that has no record without complaining', async () => {
    await expect(clearTeardownFailure(7707, registryDir)).resolves.toBeUndefined();
  });

  it('replaces the previous record rather than accumulating beside it', async () => {
    await recordTeardownFailure(7707, failure, registryDir);
    await recordTeardownFailure(7707, { ...failure, consecutiveFailures: 4 }, registryDir);
    expect(await readTeardownFailure(7707, registryDir)).toMatchObject({
      consecutiveFailures: 4,
    });
  });

  it('answers for the port it was asked about and no other', async () => {
    await recordTeardownFailure(7707, failure, registryDir);
    expect(await readTeardownFailure(7708, registryDir)).toBeUndefined();
  });

  it('reads nothing out of a record it cannot make sense of', async () => {
    await fs.writeFile(teardownFailurePath(7707, registryDir), '{ half a rec', 'utf8');
    expect(await readTeardownFailure(7707, registryDir)).toBeUndefined();
  });

  it('reads nothing out of a record missing the count that makes it legible', async () => {
    await fs.writeFile(teardownFailurePath(7707, registryDir), '{"reason":"x"}', 'utf8');
    expect(await readTeardownFailure(7707, registryDir)).toBeUndefined();
  });

  it('raises rather than reporting nothing when the record cannot be read at all', async () => {
    // Unreadable is not the same answer as absent: a record this cannot open is
    // a defect in the registry, and swallowing it would report a healthy daemon.
    await fs.mkdir(teardownFailurePath(7707, registryDir));
    await expect(readTeardownFailure(7707, registryDir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('keeps a teardown that produced no exit code readable', async () => {
    await recordTeardownFailure(7707, { ...failure, exitCode: null }, registryDir);
    expect(await readTeardownFailure(7707, registryDir)).toMatchObject({ exitCode: null });
  });

  it('is not read as a run by the registry that shares its directory', async () => {
    await recordTeardownFailure(7707, failure, registryDir);
    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
  });

  it('clears its staging file away when the write cannot land', async () => {
    await fs.mkdir(teardownFailurePath(7707, registryDir));

    await expect(recordTeardownFailure(7707, failure, registryDir)).rejects.toThrow();

    const left = await fs.readdir(registryDir);
    expect(left.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('names the failure that stopped the write rather than the one met clearing up', async () => {
    sealTheDirectoryAndFail();

    try {
      await expect(recordTeardownFailure(7707, failure, registryDir)).rejects.toMatchObject({
        cause: { code: 'EXDEV' },
      });
    } finally {
      chmodSync(registryDir, 0o700);
    }
  });
});

describe('what a human is told about a failing teardown', () => {
  it('names the port, the slot, the exit code and what the teardown said', () => {
    const message = describeTeardownFailure(7707, 3, {
      consecutiveFailures: 1,
      exitCode: 1,
      reason: 'error: required variable is missing a value',
    });
    expect(message).toContain('7707');
    expect(message).toContain('slot 3');
    expect(message).toContain('exit 1');
    expect(message).toContain('error: required variable is missing a value');
  });

  it('reads as one attempt when only one has failed so far', () => {
    const message = describeTeardownFailure(7707, 3, {
      consecutiveFailures: 1,
      exitCode: 1,
      reason: 'x',
    });
    expect(message).toContain('its last teardown attempt failed');
  });

  it('reads as a mechanism that is stuck once the attempts pile up', () => {
    const message = describeTeardownFailure(7707, 3, {
      consecutiveFailures: 27,
      exitCode: 1,
      reason: 'x',
    });
    expect(message).toContain('27 teardown attempts in a row');
  });

  it('says what goes unreclaimed for as long as it keeps failing', () => {
    const message = describeTeardownFailure(7707, 3, {
      consecutiveFailures: 27,
      exitCode: 1,
      reason: 'x',
    });
    expect(message).toContain('will not be reclaimed');
  });

  it('names an exit code the teardown never produced as one it did not', () => {
    const message = describeTeardownFailure(7707, 3, {
      consecutiveFailures: 1,
      exitCode: null,
      reason: 'x',
    });
    expect(message).toContain('no exit code');
  });
});
