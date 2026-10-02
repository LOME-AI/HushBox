import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tryLock, unlock } from 'fs-native-extensions';
import { z } from 'zod';
import { stagedWriteSync } from '../staged-write.js';
import { canonicalPath } from '../canonical-path.js';
import { SLOTS } from '../stack/port-plan.js';
import { claimsDir } from './registry.js';

/**
 * Which slot of the port plan a checkout occupies, decided by claiming it
 * rather than by hashing the checkout's name. A hash collides — `djb2` over a
 * worktree name collided for one pair in five checkouts and for two thirds of
 * twenty — and a collision is two stacks sharing one database and one bucket,
 * silently. A claim cannot collide: a slot is issued to one worktree path, and
 * every other path reading that record sees it taken.
 *
 * The registry is machine-scoped for the same reason the run registry is: ports
 * are a machine-wide resource, so two clones allocating from per-clone
 * registries would hand out one slot twice.
 *
 * A slot is reissued when the checkout holding it is gone, and the record of
 * that is git's own: `<git common dir>/worktrees/<name>` is what git removes
 * when a worktree is removed or pruned, which is exactly what drops it from
 * `git worktree list`, and a main checkout's git directory disappears with the
 * clone. Reading that directory's existence asks git's on-disk state the same
 * question `git worktree list` answers, without a subprocess — which is what
 * lets the allocation stay synchronous, as every caller of it is.
 *
 * There is no liveness question here and so no lock-held-for-a-lifetime: a slot
 * belongs to a checkout, not to a run, and outlives every run of it. The lock
 * below spans one allocation and nothing more.
 *
 * That lock covers the whole registry rather than a candidate slot, because the
 * invariant ranges over the whole registry: one checkout holds at most one slot.
 * Per-slot locking cannot express that — two claimers for one checkout would
 * hold locks on different slots at the same time, so neither excludes the other,
 * and both write. Re-scanning under a per-slot lock does not close it either:
 * both racers re-scan, both see nothing, and both write.
 *
 * Both recorded paths are canonical, because a checkout reached through a
 * symlink has two absolute spellings and every question asked here is a string
 * comparison. Resolved rather than canonical, the two spellings are two
 * checkouts: each is issued its own slot, which is the collision the claim
 * scheme replaced hashing to make impossible. The git directory is canonical
 * for the same reason from the other side — recorded through a link, its
 * existence would depend on that link surviving, and removing the link alone
 * would hand a live checkout's slot to the next claimer.
 */

/** How a slot's record is named inside the registry. */
const RECORD_PREFIX = 'slot-';
const RECORD_SUFFIX = '.json';

/**
 * The one file whose advisory lock serialises allocation. Named so that
 * {@link slotOfRecordFile} passes over it, which is what keeps the registry's
 * enumerator from ever reading it as a record.
 */
const REGISTRY_LOCK_FILE = 'registry.lock';

/** How long a claimer waits for the registry lock before failing nameably. */
const LOCK_TIMEOUT_MS = 30_000;

/** How often the wait re-offers for the lock. */
const LOCK_POLL_MS = 10;

interface SlotRecord {
  /** The checkout's working tree, as the exhaustion message and the auditor name it. */
  readonly worktreePath: string;
  /** The checkout's git directory, whose existence is what keeps the slot held. */
  readonly gitDir: string;
}

interface SlotClaimRequest extends SlotRecord {
  /** Defaults to {@link slotsDir}. */
  readonly registryDir?: string | undefined;
  /** Defaults to the port plan's slot count. */
  readonly slots?: number | undefined;
  /** Defaults to {@link LOCK_TIMEOUT_MS}. */
  readonly lockTimeoutMs?: number | undefined;
}

const recordSchema = z.object({
  worktreePath: z.string().min(1),
  gitDir: z.string().min(1),
});

/** Raised when every slot is held by a checkout that still exists. */
export class SlotsExhaustedError extends Error {
  constructor(held: ReadonlyMap<number, SlotRecord>, slots: number) {
    const lines = [...held]
      .toSorted(([left], [right]) => left - right)
      .map(([slot, record]) => `  slot ${String(slot)} → ${record.worktreePath}`);
    super(
      `No stack slot is free: all ${String(slots)} are held by checkouts that still exist.\n` +
        `${lines.join('\n')}\n` +
        `Remove a checkout you no longer need, or widen SLOTS in the port plan.`
    );
    this.name = 'SlotsExhaustedError';
  }
}

/**
 * Raised when the registry lock stayed held for the whole bounded wait. Loud by
 * design: the alternative to failing here is allocating without exclusion, which
 * is the defect this lock exists to prevent.
 */
export class RegistryLockTimeoutError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(
      `Waited ${String(timeoutMs)}ms for the stack-slot registry lock and never got it.\n` +
        `  lock → ${lockFile}\n` +
        `The kernel drops this lock the moment its holder exits, so a process on this ` +
        `machine is still running inside an allocation that takes one directory read ` +
        `and one write. Look for that stack command, in this checkout or another, and ` +
        `wait for it or stop it. The lock lives with the process rather than with the ` +
        `file, which stays on disk after every release.`
    );
    this.name = 'RegistryLockTimeoutError';
  }
}

/** The machine-wide slot registry, beside the run claims and never inside them. */
export function slotsDir(): string {
  return `${claimsDir()}-slots`;
}

function recordPath(dir: string, slot: number): string {
  return path.join(dir, `${RECORD_PREFIX}${String(slot)}${RECORD_SUFFIX}`);
}

function registryLockPath(dir: string): string {
  return path.join(dir, REGISTRY_LOCK_FILE);
}

function slotOfRecordFile(name: string): number | null {
  if (!name.startsWith(RECORD_PREFIX) || !name.endsWith(RECORD_SUFFIX)) return null;
  const slot = Number(name.slice(RECORD_PREFIX.length, -RECORD_SUFFIX.length));
  return Number.isInteger(slot) && slot >= 0 ? slot : null;
}

/**
 * The record at `slot`, or null when there is none to honour. A record written
 * by a rename is never read half-written, so an unreadable one was damaged from
 * outside the allocator, and a record naming no worktree can protect nothing:
 * reissuing the slot is the only way one recovers.
 */
function readRecord(dir: string, slot: number): SlotRecord | null {
  let raw: string;
  try {
    raw = readFileSync(recordPath(dir, slot), 'utf8');
  } catch {
    return null;
  }
  const parsed = recordSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Rename, so a reader never sees a record halfway written. */
function writeRecord(dir: string, slot: number, record: SlotRecord): void {
  stagedWriteSync(recordPath(dir, slot), JSON.stringify(record));
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

/** Every slot the registry has issued, whether or not its checkout still exists. */
export function readSlotClaims(registryDir: string = slotsDir()): Map<number, SlotRecord> {
  const claims = new Map<number, SlotRecord>();
  let names: string[];
  try {
    names = readdirSync(registryDir);
  } catch {
    return claims;
  }
  for (const name of names) {
    const slot = slotOfRecordFile(name);
    if (slot === null) continue;
    const record = readRecord(registryDir, slot);
    if (record !== null) claims.set(slot, record);
  }
  return claims;
}

/** Whether the checkout a record names is still one git would list. */
function stillCheckedOut(record: SlotRecord): boolean {
  return existsSync(record.gitDir);
}

/**
 * Blocks this thread for `ms`. `Atomics.wait` rather than a timer because the
 * whole allocation is synchronous — every caller of it is, up through files
 * this module does not own — so there is no event loop to return to.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Takes the registry lock, waiting for a holder rather than passing over it.
 * Waiting is the whole point: a claimer that gave up on a contended registry
 * would either allocate a second slot to a checkout that already has one or
 * report exhaustion that is not real. The wait is bounded because the critical
 * section is a directory read and one write, so a long one is a wedged process
 * rather than a slow neighbour.
 *
 * `waitForLock` is the library's blocking acquire, but it is asynchronous;
 * offering for the lock on an interval is how a synchronous caller waits.
 */
function acquireRegistryLock(fd: number, lockFile: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!tryLock(fd)) {
    if (Date.now() >= deadline) throw new RegistryLockTimeoutError(lockFile, timeoutMs);
    sleepSync(LOCK_POLL_MS);
  }
}

/**
 * Runs `body` as the only allocation against `dir` anywhere on the machine. An
 * advisory lock rather than the run claim's primitive because this is a
 * synchronous single-call critical section over a durable record, and the thing
 * it guards is a checkout rather than a process — no timestamp, TTL or
 * heartbeat enters it. Deadlock is not reachable: allocation never re-enters
 * itself, and the kernel releases the lock when a holder dies.
 */
function withRegistryLock<T>(dir: string, timeoutMs: number, body: () => T): T {
  const lockFile = registryLockPath(dir);
  const fd = openSync(lockFile, 'a+');
  try {
    acquireRegistryLock(fd, lockFile, timeoutMs);
    try {
      return body();
    } finally {
      unlock(fd);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The slot this checkout holds, claiming the lowest free one if it holds none.
 *
 * No slot is privileged: a main checkout claims like a worktree, because two
 * clones each have a main checkout and one machine-wide registry issues to
 * both.
 */
export function claimSlot(request: SlotClaimRequest): number {
  const dir = request.registryDir ?? slotsDir();
  const slots = request.slots ?? SLOTS;
  // Canonicalised once here rather than at each caller: everything below reads
  // the request's paths, and a spelling that reached the allocator uncanonical
  // would be compared and stored uncanonical.
  const canonical: SlotClaimRequest = {
    ...request,
    worktreePath: canonicalPath(request.worktreePath),
    gitDir: canonicalPath(request.gitDir),
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withRegistryLock(dir, request.lockTimeoutMs ?? LOCK_TIMEOUT_MS, () =>
    allocate(dir, slots, canonical)
  );
}

/**
 * Reads the registry once and issues from that reading. Sound only because it
 * runs under the registry lock: the scan that decides a checkout already holds a
 * slot and the write that gives it one are then a single act, which is what
 * makes at-most-one-slot-per-checkout hold under concurrency.
 *
 * The second loop needs no same-path case — the first returned for that — so a
 * slot is free exactly when nothing has taken it or its taker's checkout is
 * gone.
 */
function allocate(dir: string, slots: number, request: SlotClaimRequest): number {
  const claims = readSlotClaims(dir);

  for (const [slot, record] of claims) {
    if (samePath(record.worktreePath, request.worktreePath)) return slot;
  }

  for (let slot = 0; slot < slots; slot++) {
    const record = claims.get(slot);
    if (record !== undefined && stillCheckedOut(record)) continue;
    writeRecord(dir, slot, { worktreePath: request.worktreePath, gitDir: request.gitDir });
    return slot;
  }

  throw new SlotsExhaustedError(claims, slots);
}
