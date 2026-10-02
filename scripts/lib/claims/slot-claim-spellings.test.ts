import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV } from './claim.js';
import { RUN_CLAIM_ENV } from './registry.js';
import { claimSlot } from './slot-claim.js';
import type { Readable, Writable } from 'node:stream';

/**
 * A slot is issued to a checkout, and a checkout reached through a symlink has
 * two absolute spellings. The allocator compares and stores those spellings as
 * strings, so nothing but a canonical form keeps one checkout from being issued
 * two slots — the collision the claim scheme replaced hashing to make
 * impossible, reachable again through a link.
 *
 * Real processes rather than a promise fan-out: an advisory lock belongs to the
 * open file description, so claimers inside one process share the allocator's
 * own descriptors and exclude each other for a reason the registry does not
 * have. They run through tsx's loader in-process (`--import`) rather than
 * through its CLI, which forks.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLAIM_ENTRY = fileURLToPath(new URL('slot-claim-entry.mjs', import.meta.url));

type ClaimProcess = ChildProcessByStdio<Writable, Readable, null>;

/** The slot a claimer reports, once it has reported itself loaded. */
async function readSlot(line: (index: number) => Promise<string>): Promise<number> {
  return Number(await line(1));
}

/** Reads the claimer a line at a time: `ready` when loaded, then its slot. */
function lineReader(child: ClaimProcess): (index: number) => Promise<string> {
  const lines: string[] = [];
  const waiting: (() => void)[] = [];
  let buffered = '';
  let exitCode: number | null = null;

  function wake(): void {
    for (const waiter of waiting.splice(0)) waiter();
  }

  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    lines.push(...parts);
    wake();
  });
  child.once('exit', (code) => {
    exitCode = code ?? -1;
    wake();
  });

  return async (index) => {
    let line = lines[index];
    while (line === undefined) {
      if (exitCode !== null) throw new Error(`claimer exited with ${String(exitCode)}`);
      await new Promise<void>((resolve) => waiting.push(resolve));
      line = lines[index];
    }
    return line;
  };
}

/**
 * The tokens this file was invoked under. Both are cleared before every case
 * below, and a hook that puts back an empty string instead leaves every later
 * suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];
const inheritedHeldClaims = process.env[HELD_CLAIMS_ENV];

describe('a checkout with two spellings', () => {
  let registryDir = '';
  let checkouts = '';
  let children: ClaimProcess[] = [];

  /** The checkout's real spelling, and the same checkout through a link. */
  function spellings(name: string): { real: string; linked: string } {
    return {
      real: path.join(checkouts, 'real', name),
      linked: path.join(checkouts, 'link', name),
    };
  }

  function gitDirectories(name: string): { real: string; linked: string } {
    return {
      real: path.join(checkouts, 'real', 'gitdirs', name),
      linked: path.join(checkouts, 'link', 'gitdirs', name),
    };
  }

  beforeEach(() => {
    // Neutralised before the first case rather than in teardown: a token left
    // set makes the first case fail and every later one pass.
    process.env[RUN_CLAIM_ENV] = '';
    process.env[HELD_CLAIMS_ENV] = '';
    registryDir = mkdtempSync(path.join(os.tmpdir(), 'hushbox-spelling-registry-'));
    checkouts = mkdtempSync(path.join(os.tmpdir(), 'hushbox-spelling-checkouts-'));
    children = [];
    mkdirSync(path.join(checkouts, 'real'), { recursive: true });
    symlinkSync(path.join(checkouts, 'real'), path.join(checkouts, 'link'), 'dir');
  });

  afterEach(() => {
    // Ahead of the kill and the removals, because one that throws would
    // otherwise skip it. Empty string rather than absent: every reader treats an
    // empty token as none, and a computed key cannot be deleted.
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    process.env[HELD_CLAIMS_ENV] = inheritedHeldClaims ?? '';
    for (const child of children) child.kill('SIGKILL');
    rmSync(registryDir, { recursive: true, force: true });
    rmSync(checkouts, { recursive: true, force: true });
  });

  /** How many slots the registry has records for. */
  function recordCount(): number {
    return readdirSync(registryDir).filter(
      (name) => name.startsWith('slot-') && name.endsWith('.json')
    ).length;
  }

  /**
   * Spawns one claimer per spelling and releases them together, so both are
   * inside the allocation rather than running one after the other.
   */
  async function race(
    claims: readonly { worktreePath: string; gitDir: string }[]
  ): Promise<number[]> {
    const ready: Promise<string>[] = [];
    const pending: Promise<number>[] = [];

    for (const { worktreePath, gitDir } of claims) {
      const child = spawn(
        process.execPath,
        ['--import', TSX_LOADER, CLAIM_ENTRY, registryDir, worktreePath, gitDir],
        { stdio: ['pipe', 'pipe', 'inherit'] }
      ) as ClaimProcess;
      children.push(child);
      const line = lineReader(child);
      ready.push(line(0));
      pending.push(readSlot(line));
    }

    await Promise.all(ready);
    for (const child of children) child.stdin.write('\n');
    return Promise.all(pending);
  }

  it('issues one slot to claimers that reach one checkout through a link and through its real path', async () => {
    const worktree = spellings('one-checkout');
    const gitDir = gitDirectories('one-checkout');
    mkdirSync(worktree.real, { recursive: true });
    mkdirSync(gitDir.real, { recursive: true });

    const slots = await race([
      { worktreePath: worktree.real, gitDir: gitDir.real },
      { worktreePath: worktree.linked, gitDir: gitDir.linked },
    ]);

    expect(new Set(slots).size).toBe(1);
    expect(recordCount()).toBe(1);
  }, 60_000);

  it('keeps a slot held when the link its claimer named is gone and the checkout is not', () => {
    const held = spellings('held-checkout');
    const heldGitDir = gitDirectories('held-checkout');
    const other = spellings('other-checkout');
    const otherGitDir = gitDirectories('other-checkout');
    mkdirSync(held.real, { recursive: true });
    mkdirSync(heldGitDir.real, { recursive: true });
    mkdirSync(other.real, { recursive: true });
    mkdirSync(otherGitDir.real, { recursive: true });

    const first = claimSlot({
      worktreePath: held.linked,
      gitDir: heldGitDir.linked,
      registryDir,
    });
    unlinkSync(path.join(checkouts, 'link'));

    const second = claimSlot({
      worktreePath: other.real,
      gitDir: otherGitDir.real,
      registryDir,
    });

    expect(second).not.toBe(first);
    expect(recordCount()).toBe(2);
  });
});
