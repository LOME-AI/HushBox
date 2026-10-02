import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV } from './claim.js';
import { RUN_CLAIM_ENV } from './registry.js';
import type { Readable, Writable } from 'node:stream';

/**
 * Concurrency here is a fact about processes contending for one registry on
 * disk, so only real processes can produce it: claimers inside one process
 * would share the allocator's descriptors, and an advisory lock is held by the
 * open file description rather than by the caller. The claimers run through
 * tsx's loader in-process (`--import`) rather than through its CLI, which
 * forks, so the process that allocates is the one this test started.
 *
 * Two properties are asserted, and they pull in opposite directions: claimers
 * for different checkouts must never share a slot, and claimers for one
 * checkout must never split across slots. An allocator locking each candidate
 * slot rather than the registry satisfies the first and fails the second, which
 * is why both are here.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLAIM_ENTRY = fileURLToPath(new URL('slot-claim-entry.mjs', import.meta.url));

/** How many claimers race. Enough that a scheme issuing by chance would repeat. */
const CLAIMERS = 8;

type ClaimProcess = ChildProcessByStdio<Writable, Readable, null>;

/**
 * Reads the claimer's output a line at a time: it prints `ready` when it is
 * loaded and the slot it was issued after that.
 */
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

      // iteration resumes on the next line of output and re-reads.
      await new Promise<void>((resolve) => waiting.push(resolve));
      line = lines[index];
    }
    return line;
  };
}

/** The slot a claimer reports, once it has reported itself loaded. */
async function slotOf(line: (index: number) => Promise<string>): Promise<number> {
  return Number(await line(1));
}

/**
 * The tokens this file was invoked under. Both are cleared before every case
 * below, and a hook that puts back an empty string instead leaves every later
 * suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];
const inheritedHeldClaims = process.env[HELD_CLAIMS_ENV];

describe('concurrent slot claimers', () => {
  let registryDir: string;
  let checkouts: string;
  let children: ClaimProcess[];

  beforeEach(() => {
    // Neutralised before the first case rather than after it: a token cleared
    // only in teardown makes the first case fail and every later one pass.
    process.env[RUN_CLAIM_ENV] = '';
    process.env[HELD_CLAIMS_ENV] = '';
    registryDir = mkdtempSync(path.join(os.tmpdir(), 'hushbox-slot-race-registry-'));
    checkouts = mkdtempSync(path.join(os.tmpdir(), 'hushbox-slot-race-checkouts-'));
    children = [];
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

  /**
   * Spawns one claimer per checkout name and releases them all only once every
   * one has reported itself loaded. Released as they are spawned, they allocate
   * one after another as they finish starting up and the registry is never
   * actually contended — an earlier form of this suite passed against a broken
   * allocator for exactly that reason.
   */
  async function race(checkoutNames: readonly string[]): Promise<number[]> {
    const pending: Promise<number>[] = [];
    const ready: Promise<string>[] = [];
    for (const name of checkoutNames) {
      const worktreePath = path.join(checkouts, name);
      const gitDir = path.join(checkouts, 'gitdirs', name);
      mkdirSync(worktreePath, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      const child = spawn(
        process.execPath,
        ['--import', TSX_LOADER, CLAIM_ENTRY, registryDir, worktreePath, gitDir],
        { stdio: ['pipe', 'pipe', 'inherit'] }
      ) as ClaimProcess;
      children.push(child);
      const line = lineReader(child);
      ready.push(line(0));
      pending.push(slotOf(line));
    }

    await Promise.all(ready);
    for (const child of children) child.stdin.write('\n');
    return Promise.all(pending);
  }

  /** How many slots the registry has records for. */
  function recordCount(): number {
    return readdirSync(registryDir).filter(
      (name) => name.startsWith('slot-') && name.endsWith('.json')
    ).length;
  }

  it('issues one distinct slot to each of many claimers racing in their own processes', async () => {
    const slots = await race(
      Array.from({ length: CLAIMERS }, (_unused, index) => `checkout-${String(index)}`)
    );

    expect(new Set(slots).size).toBe(CLAIMERS);
    expect(slots.toSorted((left, right) => left - right)).toEqual(
      Array.from({ length: CLAIMERS }, (_unused, index) => index)
    );
    expect(recordCount()).toBe(CLAIMERS);
  }, 60_000);

  it('issues one slot and writes one record when every racing claimer is the same checkout', async () => {
    const slots = await race(Array.from({ length: CLAIMERS }, () => 'one-checkout'));

    expect(new Set(slots)).toEqual(new Set([0]));
    expect(recordCount()).toBe(1);
  }, 60_000);
});
