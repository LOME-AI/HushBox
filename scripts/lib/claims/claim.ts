import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { tryLock as tryNativeLock, unlock, waitForLock } from 'fs-native-extensions';
import { canonicalPath } from '../canonical-path.ts';
import type { FileHandle } from 'node:fs/promises';

/**
 * A claim is both a mutex over a shared resource and a liveness token for the
 * run holding it. Both properties come from one OS advisory lock on the claim's
 * own file: a run that holds the lock is alive, and the kernel releases the lock
 * the instant that run's last descriptor closes — including when it is killed.
 *
 * There is deliberately no heartbeat, no TTL and no timestamp in the liveness
 * decision. A heartbeat *infers* liveness from a clock and gets both directions
 * wrong: under `SIGSTOP` a heartbeat-plus-TTL declares a live holder dead
 * (the process is frozen, so it cannot write), and after `SIGKILL` it declares a
 * dead holder alive for a full TTL (the last beat is still recent). The lock
 * answers both correctly and immediately, because it is a kernel fact rather
 * than an inference: a frozen process still holds its lock, and a killed one
 * holds nothing.
 *
 * The lock file's bytes belong to this primitive: it writes the holder
 * description there so a refusal and a progress line can name who to wait for.
 * A caller that keeps a richer record of its run keeps it in a sibling file.
 *
 * The name is published before the lock is requested and republished in place
 * once it is granted, which is what makes this hold of the file: *at every
 * instant some run holds the lock, the file is non-empty*. A run reaches the
 * lock request only past a file that already carried a name or that it named
 * itself, and no write here shortens or empties the file. Non-empty is the
 * whole of it, and it is what {@link acquire}'s emptiness test rests on: the
 * republish runs while the lock is held and grows the file, so the first line
 * being a *whole* name is not something any instant guarantees.
 *
 * What a reader gets is a separate question, and the bytes on disk do not
 * settle it. A read of a file being grown comes back clamped to the size the
 * kernel sampled, and that size lags the pages the write has already put
 * there, so the window can hold the beginning of the name going in and nothing
 * more. The terminating newline is what tells the two apart: a window carrying
 * none is a name still being published, and {@link tryLock} says so rather than
 * handing a fragment back as a whole name. Both halves are needed — writing the
 * name only after taking the lock left a probe reading a held claim with
 * nothing in it, and accepting a newline-free window left one reading a
 * fragment — and either way a reader that parses the name reports a live
 * holder as unidentified.
 *
 * Re-entrancy is *inherited* only. A child process proceeds through a claim its
 * parent holds, because the parent stamps the claim into the environment the
 * child inherits. A second claim on the same resource from the same process is
 * not re-entrant — it meets its own lock, which refuses in `refuse` mode and
 * would wait forever in `wait` mode.
 *
 * The file is never unlinked on release. Unlinking a lock file races: a waiter
 * that opened the file before the unlink would lock a deleted inode while the
 * next acquirer creates and locks a fresh one, and both would believe they hold
 * the resource.
 *
 * The lock path is canonicalised on the way in, because the inherited set is a
 * set of strings while the lock itself is a kernel fact about an inode. A
 * directory reached through a symlink has two absolute spellings, and a parent
 * stamping one while a child names the other would leave the child meeting the
 * lock its own parent holds — refused, or waiting for something that will never
 * let go.
 */

/**
 * Carries the claims this process holds to every process it spawns. A newline
 * separates entries because a path may contain the platform path delimiter.
 */
export const HELD_CLAIMS_ENV = 'HB_HELD_CLAIMS';

/** How often a `wait` reports who it is waiting for. */
export const PROGRESS_INTERVAL_MS = 5000;

/** Stands in when the holder's own description cannot be read back. */
const UNNAMED_HOLDER = 'another run';

/**
 * The window one read of a holder's name takes, and so the most a name may
 * occupy. A name is a phrase a person reads in a refusal; anything approaching
 * this is a caller defect, and {@link publishHolder} refuses it rather than
 * storing a name no reader can get back whole.
 */
const HOLDER_BYTES = 8192;

export type OnHeld = 'refuse' | 'wait';

export interface ClaimResource {
  /** What the resource is called in a refusal or a progress line. */
  readonly name: string;
  /** The file whose advisory lock is the claim. */
  readonly lockPath: string;
}

interface ClaimOptions {
  readonly onHeld: OnHeld;
  /** How this run names itself to whoever is refused or kept waiting. */
  readonly holder: string;
  /** Where a `wait` reports progress. Defaults to standard error. */
  readonly log?: (line: string) => void;
  readonly progressIntervalMs?: number;
}

interface LockProbe {
  /** `true` while a live run holds the claim. */
  readonly held: boolean;
  /** The holder's own description, or `null` when nothing holds the claim. */
  readonly holder: string | null;
  /**
   * Present, and only ever `true`, where the claim is held and the read caught
   * the holder's name going in: the window carried no terminating newline, so
   * its bytes are the beginning of a name rather than a whole one. Absent
   * everywhere else, so a probe of a claim whose holder reads whole stays the
   * two facts it has always been.
   *
   * A holder not yet readable is a different fact from a holder that named
   * itself with nothing, and a consumer that acts on the name has to tell them
   * apart: the first is a live run a further read resolves, so reporting it as
   * the second asks a human to investigate something that is working.
   */
  readonly holderPending?: true;
}

/** Raised instead of running the body. `wait` never raises it. */
export class ClaimHeldError extends Error {
  readonly resource: string;
  readonly holder: string;

  constructor(resource: string, holder: string) {
    super(
      `\`${resource}\` is claimed by \`${holder}\`. This run refused rather than ` +
        `run beside it. Re-run once that finishes.`
    );
    this.name = 'ClaimHeldError';
    this.resource = resource;
    this.holder = holder;
  }
}

/**
 * The claims acquired by this process, as opposed to the ones it inherited.
 * Both live in the environment variable; only this set tells them apart.
 */
const acquiredHere = new Set<string>();

function envEntries(): string[] {
  const raw = process.env[HELD_CLAIMS_ENV];
  if (raw === undefined || raw === '') return [];
  return raw.split('\n');
}

function isInherited(lockPath: string): boolean {
  return envEntries().includes(lockPath) && !acquiredHere.has(lockPath);
}

function markAcquired(lockPath: string): void {
  acquiredHere.add(lockPath);
  process.env[HELD_CLAIMS_ENV] = [...envEntries(), lockPath].join('\n');
}

function markReleased(lockPath: string): void {
  acquiredHere.delete(lockPath);
  process.env[HELD_CLAIMS_ENV] = envEntries()
    .filter((entry) => entry !== lockPath)
    .join('\n');
}

/**
 * Every descriptor this module has open on a claim file, held strongly until it
 * closes that descriptor itself.
 *
 * The lock is a fact about a descriptor, and Node closes a `FileHandle`'s
 * descriptor from a finalizer as soon as the handle stops being reachable — it
 * says so on the way out, `Closing file descriptor N on garbage collection`.
 * So a collected handle drops the lock while the run holding it is still
 * running, every probe reads that live run as ended, and every reclaimer culls
 * what it owns.
 *
 * The reachability a lock gets for free is that its handle is a local of a live
 * frame, a frame suspended at an await included: those locals survive whether
 * or not anything reads them again. What ends it is the handle ceasing to be a
 * local of any live frame at all, and that is one edit away — this module
 * passes bare descriptor numbers to the native lock calls, so handing a caller
 * the number rather than the handle reads as simplification while leaving the
 * handle to a frame that has returned. The lock goes with it, mid-run and
 * without a sound.
 *
 * This set is the reachability the lock owns for itself instead, so that edit
 * keeps the lock and lands as a failing test rather than as silence: nothing
 * may take a handle out of here before the descriptor carrying that handle's
 * lock is closed, so a release that does not go through {@link closeClaimFile}
 * leaves one behind and {@link openClaimFileCount} says so.
 */
const openClaimFiles = new Set<FileHandle>();

/** Opens a claim file, and holds the handle for as long as it stays open. */
async function openClaimFile(lockPath: string, flags: string): Promise<FileHandle> {
  const handle = await open(lockPath, flags);
  openClaimFiles.add(handle);
  return handle;
}

/** Closes a claim file, which is the one moment its handle may be let go. */
async function closeClaimFile(handle: FileHandle): Promise<void> {
  openClaimFiles.delete(handle);
  await handle.close();
}

/**
 * How many claim files this module currently holds open. Published so that
 * {@link openClaimFiles} has a test of its own: a retention nothing observes is
 * a retention the next reader deletes.
 */
export function openClaimFileCount(): number {
  return openClaimFiles.size;
}

/** What one read of a claim file made of the holder's name. */
interface HolderReading {
  /** The name, or {@link UNNAMED_HOLDER} where none could be read. */
  readonly name: string;
  /**
   * `true` where the window carried no terminating newline, so its bytes are
   * the beginning of a name still being published rather than a whole one.
   */
  readonly pending: boolean;
}

/**
 * Best-effort by construction: the file may be mid-write, or unreadable while
 * another process holds it. A run still has to be able to say who it is waiting
 * for, so an unreadable holder becomes a name rather than a failure.
 *
 * One read of a fixed window, never `readFile`, which sizes its read from a
 * `stat` it takes first: a name written over a shorter one leaves that `stat`
 * short of the name now there, and the read comes back a prefix of it — a
 * holder as unusable as no holder at all. Asking for a window wider than any
 * name narrows that and does not close it, because the kernel clamps the count
 * it returns to the size it sampled, and that size lags the pages a growing
 * write has already put there. What rules a prefix out is the newline the
 * publish writes: a window carrying none is a name still going in, reported as
 * such rather than returned as a name.
 *
 * The first line is the name; what follows it is what longer predecessors left,
 * since nothing here ever shortens the file.
 */
async function readHolder(lockPath: string): Promise<HolderReading> {
  try {
    const handle = await openClaimFile(lockPath, 'r');
    try {
      const window = Buffer.alloc(HOLDER_BYTES);
      const { bytesRead } = await handle.read(window, 0, HOLDER_BYTES, 0);
      const text = window.subarray(0, bytesRead).toString('utf8');
      const ends = text.indexOf('\n');
      if (ends === -1) return { name: UNNAMED_HOLDER, pending: true };
      const named = text.slice(0, ends).trim();
      return { name: named === '' ? UNNAMED_HOLDER : named, pending: false };
    } finally {
      await closeClaimFile(handle);
    }
  } catch {
    /* v8 ignore next 2 -- the read fails only inside the window between the
       lock probe and this read, and that window belongs to whichever process
       removes the file or revokes access; one process cannot put itself
       inside it. */
    return { name: UNNAMED_HOLDER, pending: false };
  }
}

/**
 * `r+` on three counts: an exclusive lock is granted only on a writable
 * descriptor, the `w` flags would truncate a file another run is holding, and
 * `a+` would send the holder's name to the end of the file instead of over the
 * name it replaces.
 */
async function openLock(lockPath: string): Promise<FileHandle> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    return await openClaimFile(lockPath, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // `a`, so two runs arriving at a claim neither has taken before both end up
  // on the one file rather than one erasing the other's name.
  const created = await openClaimFile(lockPath, 'a');
  await closeClaimFile(created);
  return openClaimFile(lockPath, 'r+');
}

/**
 * Puts `holder` at the front of the file in one write, over whatever name was
 * there.
 *
 * Nothing shortens the file, deliberately. A file that shrinks can be read as a
 * prefix of the name it used to carry — a holder as unusable as no holder at
 * all — so the remains of a longer predecessor are left past the newline
 * instead, where {@link readHolder} does not look. The file therefore reaches
 * the length of the longest name it has ever carried and stops there.
 */
async function publishHolder(handle: FileHandle, holder: string): Promise<void> {
  // The newline is what makes even a run that names itself with nothing write
  // a byte, and a file with a byte in it is the whole published-before-locked
  // signal a probe reads.
  const line = Buffer.from(`${holder}\n`, 'utf8');
  if (line.length > HOLDER_BYTES) {
    throw new Error(
      `A claim holder must fit in ${String(HOLDER_BYTES)} bytes so a reader can ` +
        `get it back whole; this one is ${String(line.length)}.`
    );
  }
  await handle.write(line, 0, line.length, 0);
}

function defaultLog(line: string): void {
  console.error(line);
}

async function waitForHolder(
  handle: FileHandle,
  resource: ClaimResource,
  options: ClaimOptions
): Promise<void> {
  const log = options.log ?? defaultLog;
  const startedAt = Date.now();
  // Read once, up front, so the progress line is a synchronous callback:
  // clearing the timer then guarantees no line is printed after the wait ends.
  const { name: holder } = await readHolder(resource.lockPath);

  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    log(`waiting for \`${resource.name}\`, held by \`${holder}\` (${String(seconds)}s)`);
  }, options.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
  // Never the reason the process stays alive: the work behind the claim is.
  timer.unref();

  try {
    // No timeout: a live holder may legitimately run for minutes, and a dead
    // one has already released, so waiting can only end one of two ways.
    await waitForLock(handle.fd);
  } finally {
    clearInterval(timer);
  }
}

async function acquire(resource: ClaimResource, options: ClaimOptions): Promise<FileHandle> {
  const handle = await openLock(resource.lockPath);
  try {
    // An empty file is one no run holds, because every run names itself here
    // before it asks for the lock and nothing ever empties the file again. So
    // this cannot overwrite a live holder, and past it the lock request cannot
    // be granted over an unnamed claim.
    const { size } = await handle.stat();
    if (size === 0) await publishHolder(handle, options.holder);
    if (!tryNativeLock(handle.fd)) {
      if (options.onHeld === 'refuse') {
        const { name: holder } = await readHolder(resource.lockPath);
        throw new ClaimHeldError(resource.name, holder);
      }
      await waitForHolder(handle, resource, options);
    }
    return handle;
  } catch (error) {
    await closeClaimFile(handle);
    throw error;
  }
}

/**
 * Whether a live run holds the claim at `lockPath`, and what it calls itself.
 * The probe takes the lock and drops it again, so a claim whose holder was
 * killed reads as free the instant the kernel reaps it. A holder whose name the
 * read caught going in is answered as one, not as a name — see
 * {@link LockProbe.holderPending}.
 */
export async function tryLock(lockPath: string): Promise<LockProbe> {
  let handle: FileHandle;
  try {
    // Never `a+` here: probing must not bring a claim file into existence.
    handle = await openClaimFile(lockPath, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { held: false, holder: null };
    throw error;
  }

  let granted = false;
  try {
    granted = tryNativeLock(handle.fd);
    if (granted) unlock(handle.fd);
  } finally {
    await closeClaimFile(handle);
  }

  if (granted) return { held: false, holder: null };
  const reading = await readHolder(lockPath);
  if (reading.pending) return { held: true, holder: reading.name, holderPending: true };
  return { held: true, holder: reading.name };
}

/**
 * Runs `body` while holding `resource`, releasing it however the body ends.
 * `refuse` throws {@link ClaimHeldError} naming the holder; `wait` queues behind
 * it, reporting who it is waiting for and for how long.
 */
export async function claim<T>(
  resource: ClaimResource,
  options: ClaimOptions,
  body: () => Promise<T>
): Promise<T> {
  const lockPath = canonicalPath(resource.lockPath);
  if (isInherited(lockPath)) return body();

  const target: ClaimResource = { name: resource.name, lockPath };
  const handle = await acquire(target, options);
  try {
    await publishHolder(handle, options.holder);
    markAcquired(lockPath);
    return await body();
  } finally {
    markReleased(lockPath);
    unlock(handle.fd);
    await closeClaimFile(handle);
  }
}
