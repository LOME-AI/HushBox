import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tryLock, unlock } from 'fs-native-extensions';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as atomicRename from '@hushbox/shared/atomic-rename';
import { HELD_CLAIMS_ENV } from './claim.js';
import { RUN_CLAIM_ENV } from './registry.js';
import {
  RegistryLockTimeoutError,
  SlotsExhaustedError,
  claimSlot,
  readSlotClaims,
  slotsDir,
} from './slot-claim.js';

/** The lock every allocation against a registry takes, whichever slot it issues. */
const REGISTRY_LOCK = 'registry.lock';

/**
 * Seals the directory the write is landing in and then fails. Sealing is what
 * makes the clean-up after a failed write genuinely unable to unlink, and no
 * filesystem state produces that on its own: the staging file is written while
 * the directory is still writable, and the only moment between that write and
 * the clean-up belongs to the rename.
 */
function sealTheDirectoryAndFail(): void {
  vi.spyOn(atomicRename, 'renameWithRetrySync').mockImplementationOnce((_from, to) => {
    chmodSync(path.dirname(to), 0o555);
    throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  });
}

/**
 * The holder fixture the claim primitive's own suite uses, spawned here against
 * the registry lock: only another process can hold a lock and then let go of it
 * while this process is blocked waiting for it.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const HOLDER_ENTRY = fileURLToPath(new URL('claim-holder-entry.mjs', import.meta.url));

/**
 * A checkout the allocator can see, staged under `root`: a directory standing
 * for the working tree and one standing for the git directory whose existence
 * is what says the checkout is still registered.
 */
function stageCheckout(root: string, name: string): { worktreePath: string; gitDir: string } {
  const worktreePath = path.join(root, name);
  const gitDir = path.join(root, 'gitdirs', name);
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  return { worktreePath, gitDir };
}

/**
 * The tokens this file was invoked under. Both are cleared before every case
 * below, and a hook that puts back an empty string instead leaves every later
 * suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];
const inheritedHeldClaims = process.env[HELD_CLAIMS_ENV];

describe('slot claims', () => {
  let registryDir: string;
  let checkouts: string;

  beforeEach(() => {
    // Both tokens are inherited from whatever invoked the suite, and the
    // allocator's own lock lives in the same environment. Neutralised before
    // the first case rather than after it: a token cleared only in teardown
    // makes the first case of the file fail and every later one pass.
    process.env[RUN_CLAIM_ENV] = '';
    process.env[HELD_CLAIMS_ENV] = '';
    registryDir = mkdtempSync(path.join(os.tmpdir(), 'hushbox-slot-registry-'));
    checkouts = mkdtempSync(path.join(os.tmpdir(), 'hushbox-slot-checkouts-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Empty string rather than absent: every reader treats an empty token as
    // none, and a computed key cannot be deleted.
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    process.env[HELD_CLAIMS_ENV] = inheritedHeldClaims ?? '';
    rmSync(registryDir, { recursive: true, force: true });
    rmSync(checkouts, { recursive: true, force: true });
  });

  it('gives the first checkout the lowest slot', () => {
    const first = stageCheckout(checkouts, 'alpha');

    expect(claimSlot({ ...first, registryDir })).toBe(0);
  });

  it('gives a second checkout the next slot', () => {
    const first = stageCheckout(checkouts, 'alpha');
    const second = stageCheckout(checkouts, 'beta');

    claimSlot({ ...first, registryDir });

    expect(claimSlot({ ...second, registryDir })).toBe(1);
  });

  it('returns the slot it already issued when the same checkout claims again', () => {
    const first = stageCheckout(checkouts, 'alpha');
    const second = stageCheckout(checkouts, 'beta');
    claimSlot({ ...first, registryDir });
    const issued = claimSlot({ ...second, registryDir });

    expect(claimSlot({ ...second, registryDir })).toBe(issued);
  });

  it('privileges no checkout: a main checkout takes whatever slot is lowest and free', () => {
    const worktree = stageCheckout(checkouts, 'a-worktree');
    const main = stageCheckout(checkouts, 'a-clone');
    claimSlot({ ...worktree, registryDir });

    expect(claimSlot({ ...main, registryDir })).toBe(1);
  });

  it('reissues the slot of a checkout whose git directory is gone', () => {
    const departed = stageCheckout(checkouts, 'departed');
    const arriving = stageCheckout(checkouts, 'arriving');
    claimSlot({ ...departed, registryDir });
    rmSync(departed.gitDir, { recursive: true, force: true });

    expect(claimSlot({ ...arriving, registryDir })).toBe(0);
  });

  it('leaves the slot of a checkout whose git directory is still there', () => {
    const staying = stageCheckout(checkouts, 'staying');
    const arriving = stageCheckout(checkouts, 'arriving');
    claimSlot({ ...staying, registryDir });

    expect(claimSlot({ ...arriving, registryDir })).toBe(1);
  });

  it('fills the lowest gap a departure left rather than appending', () => {
    const first = stageCheckout(checkouts, 'first');
    const second = stageCheckout(checkouts, 'second');
    const third = stageCheckout(checkouts, 'third');
    claimSlot({ ...first, registryDir });
    claimSlot({ ...second, registryDir });
    rmSync(first.gitDir, { recursive: true, force: true });

    expect(claimSlot({ ...third, registryDir })).toBe(0);
  });

  it('reissues a slot whose record cannot be read', () => {
    const arriving = stageCheckout(checkouts, 'arriving');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(path.join(registryDir, 'slot-0.json'), 'not json at all', 'utf8');

    expect(claimSlot({ ...arriving, registryDir })).toBe(0);
  });

  it('fails naming every held slot and its worktree when the slot space is full', () => {
    const first = stageCheckout(checkouts, 'holder-one');
    const second = stageCheckout(checkouts, 'holder-two');
    const arriving = stageCheckout(checkouts, 'arriving');
    claimSlot({ ...first, registryDir, slots: 2 });
    claimSlot({ ...second, registryDir, slots: 2 });

    let raised: unknown;
    try {
      claimSlot({ ...arriving, registryDir, slots: 2 });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(SlotsExhaustedError);
    const message = (raised as Error).message;
    expect(message).toContain(`slot 0 → ${first.worktreePath}`);
    expect(message).toContain(`slot 1 → ${second.worktreePath}`);
    expect(message).toContain('all 2 are held by checkouts that still exist');
  });

  it('reads back which worktree holds each slot', () => {
    const first = stageCheckout(checkouts, 'alpha');
    claimSlot({ ...first, registryDir });

    expect(readSlotClaims(registryDir).get(0)?.worktreePath).toBe(first.worktreePath);
  });

  it('reports no claim for a slot nothing has taken', () => {
    const first = stageCheckout(checkouts, 'alpha');
    claimSlot({ ...first, registryDir });

    expect(readSlotClaims(registryDir).has(1)).toBe(false);
  });

  it('ignores a registry file whose name carries no slot number', () => {
    const first = stageCheckout(checkouts, 'alpha');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(path.join(registryDir, 'slot-nowhere.json'), '{}', 'utf8');

    claimSlot({ ...first, registryDir });

    expect([...readSlotClaims(registryDir).keys()]).toEqual([0]);
  });

  it('ignores the staging file of a write in flight', () => {
    const first = stageCheckout(checkouts, 'alpha');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      path.join(registryDir, `slot-1.json.${String(process.pid)}-in-flight.tmp`),
      JSON.stringify({ worktreePath: '/nowhere', gitDir: '/nowhere' }),
      'utf8'
    );

    claimSlot({ ...first, registryDir });

    expect([...readSlotClaims(registryDir).keys()]).toEqual([0]);
  });

  it('clears its staging file away when the record cannot land', () => {
    const first = stageCheckout(checkouts, 'alpha');
    mkdirSync(path.join(registryDir, 'slot-0.json'), { recursive: true });

    expect(() => claimSlot({ ...first, registryDir })).toThrow();

    expect(readdirSync(registryDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('names the failure that stopped the write rather than the one met clearing up', () => {
    const first = stageCheckout(checkouts, 'alpha');
    mkdirSync(registryDir, { recursive: true });
    sealTheDirectoryAndFail();

    try {
      expect(() => claimSlot({ ...first, registryDir })).toThrow(
        expect.objectContaining({ cause: expect.objectContaining({ code: 'EXDEV' }) })
      );
    } finally {
      chmodSync(registryDir, 0o700);
    }
  });

  it('waits for an allocation in flight rather than passing over the slot it is taking', async () => {
    const arriving = stageCheckout(checkouts, 'arriving');
    mkdirSync(registryDir, { recursive: true });
    const holder = spawn(
      process.execPath,
      [
        '--import',
        TSX_LOADER,
        HOLDER_ENTRY,
        path.join(registryDir, REGISTRY_LOCK),
        'slot registry',
        'a neighbouring allocation',
        'refuse',
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] }
    );
    try {
      await new Promise<void>((resolve) =>
        holder.stdout.once('data', () => {
          resolve();
        })
      );
      // Told to let go and then raced: the release needs the holder to be
      // scheduled, so this process meets the lock held and has to wait for it.
      holder.stdin.write('\n');

      expect(claimSlot({ ...arriving, registryDir })).toBe(0);
    } finally {
      holder.kill('SIGKILL');
    }
  }, 30_000);

  it('fails naming the lock when an allocation in flight never lets go', () => {
    const arriving = stageCheckout(checkouts, 'arriving');
    mkdirSync(registryDir, { recursive: true });
    // A second descriptor conflicts with the first even inside one process,
    // which is what lets this stand in for an allocation that never finishes.
    const lockFile = path.join(registryDir, REGISTRY_LOCK);
    const fd = openSync(lockFile, 'a+');
    expect(tryLock(fd)).toBe(true);
    try {
      expect(() => claimSlot({ ...arriving, registryDir, lockTimeoutMs: 50 })).toThrow(
        RegistryLockTimeoutError
      );
      expect(() => claimSlot({ ...arriving, registryDir, lockTimeoutMs: 50 })).toThrow(lockFile);
      expect(readSlotClaims(registryDir).size).toBe(0);
    } finally {
      unlock(fd);
      closeSync(fd);
    }
  }, 30_000);

  it('sends a timed-out claimer after the process still holding the lock, not after its file', () => {
    const arriving = stageCheckout(checkouts, 'arriving');
    mkdirSync(registryDir, { recursive: true });
    const lockFile = path.join(registryDir, REGISTRY_LOCK);
    const fd = openSync(lockFile, 'a+');
    expect(tryLock(fd)).toBe(true);
    try {
      let raised: unknown;
      try {
        claimSlot({ ...arriving, registryDir, lockTimeoutMs: 50 });
      } catch (error) {
        raised = error;
      }

      // Read without the path, so the fixture directory's own name can neither
      // satisfy nor defeat what the guidance is asserted to say.
      const guidance = (raised as Error).message.replaceAll(lockFile, '');
      expect(guidance).toMatch(/still running/);
      // Removing the lock file is the one repair the message must never
      // suggest: the holder keeps its lock on the unlinked inode while the
      // next opener creates and locks a fresh file, so both allocate at once.
      expect(guidance).not.toMatch(/\b(?:remove|delete)\b/i);
    } finally {
      unlock(fd);
      closeSync(fd);
    }
  });

  it('allocates from the machine-wide registry when given none of its own', () => {
    // The temporary directory is what makes that registry machine-wide, so
    // moving it is how this exercises the default without writing a record
    // into the registry every checkout on this machine shares.
    vi.stubEnv('TMPDIR', registryDir);
    const first = stageCheckout(checkouts, 'unregistered');

    const slot = claimSlot(first);

    expect(readSlotClaims().get(slot)?.worktreePath).toBe(first.worktreePath);
    expect(existsSync(slotsDir())).toBe(true);
    expect(slotsDir().startsWith(registryDir)).toBe(true);
  });

  it('reads an empty set from a registry that was never written', () => {
    expect(readSlotClaims(path.join(registryDir, 'never-written')).size).toBe(0);
  });

  it('names a registry directory of its own, apart from the run claims', () => {
    expect(path.basename(slotsDir())).toMatch(/slots$/);
  });
});
