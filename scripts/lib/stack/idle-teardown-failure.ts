import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { stagedWrite } from '../staged-write.js';
import { claimsDir } from '../claims/registry.js';

/**
 * What the idle daemon leaves behind when the one destructive thing it does
 * cannot be done.
 *
 * The daemon is spawned detached with its output discarded and its handle
 * released, and nothing ever reads its exit code — so a teardown that fails for
 * a reason that will not change is retried once per poll forever and nobody
 * learns of it. Exiting instead of looping would be exactly as invisible; the
 * discarded output is the defect, so the daemon writes what it would have
 * printed somewhere that outlives the process, and `scripts/lib/stack/idle-killer.ts`'s
 * `ensureDaemonRunning` reads it out loud — that is the call every stack
 * bring-up already makes, so the evidence arrives where a developer is looking
 * rather than where one would have to know to look.
 *
 * Nothing here enters a liveness decision. The record carries a count of
 * attempts and no instant at all, the daemon never reads back the count it
 * wrote — its own attempts are counted in memory — and whether a daemon is
 * alive is still the advisory lock on its identity claim and nothing else.
 *
 * It sits beside the identity claim in the run registry, because a port is a
 * machine-wide resource and the port is the only thing a reader starts from.
 * The leading dot is load-bearing: `scripts/lib/claims/registry.ts`'s
 * `enumerateClaims` reads every other name in that directory as a run record.
 */
export interface TeardownFailure {
  /** Teardown attempts that have failed in a row, this one included. */
  readonly consecutiveFailures: number;
  /** What the teardown exited with, or null when it produced no code. */
  readonly exitCode: number | null;
  /** The last thing the failing teardown printed. */
  readonly reason: string;
}

/** Beyond this a line stops being a reason and starts being a transcript. */
const REASON_MAX_LENGTH = 200;

const failureSchema = z.object({
  consecutiveFailures: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  reason: z.string().min(1),
});

export function teardownFailurePath(port: number, registryDir: string = claimsDir()): string {
  return path.join(registryDir, `.idle-daemon-${String(port)}.teardown-failure`);
}

/**
 * The one line worth keeping out of everything a failing teardown printed.
 * Compose reports what went wrong last, after whatever it managed to do first,
 * so the last line it left is the one that says why it stopped.
 */
export function teardownReason(output: string): string {
  const last = output
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => line !== '');
  if (last === undefined) return 'it printed nothing';
  return last.length > REASON_MAX_LENGTH ? `${last.slice(0, REASON_MAX_LENGTH - 3)}...` : last;
}

/** Rename, so a reader never meets a record halfway written. */
export async function recordTeardownFailure(
  port: number,
  failure: TeardownFailure,
  registryDir?: string
): Promise<void> {
  await stagedWrite(teardownFailurePath(port, registryDir), JSON.stringify(failure));
}

/**
 * Forgets everything about this port's teardowns. Called when one finally
 * succeeds, and again by the next daemon to take the port: a record describes
 * the attempts of the daemon that wrote it, and a successor can speak only for
 * its own.
 */
export async function clearTeardownFailure(port: number, registryDir?: string): Promise<void> {
  await rm(teardownFailurePath(port, registryDir), { force: true });
}

/**
 * What this port's daemon last said about its teardown, or nothing when it has
 * said nothing this can act on. A record too damaged to parse reads as nothing
 * rather than as a failure: the daemon rewrites it on its next attempt.
 */
export async function readTeardownFailure(
  port: number,
  registryDir?: string
): Promise<TeardownFailure | undefined> {
  let raw: string;
  try {
    raw = await readFile(teardownFailurePath(port, registryDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = failureSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : undefined;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * The sentence a human gets. The count is in it because one failed attempt and
 * twenty-seven are different situations: the first is a teardown that may well
 * succeed on the next poll, the second is a mechanism that will never succeed
 * and is retrying anyway. A teardown that failed once and then succeeded leaves
 * no record at all, so nothing is said about it.
 */
export function describeTeardownFailure(
  port: number,
  slot: number,
  failure: TeardownFailure
): string {
  const attempts =
    failure.consecutiveFailures === 1
      ? 'its last teardown attempt failed'
      : `its last ${String(failure.consecutiveFailures)} teardown attempts in a row all failed`;
  const code = failure.exitCode === null ? 'no exit code' : `exit ${String(failure.exitCode)}`;
  return (
    `idle daemon on port ${String(port)} (slot ${String(slot)}): ${attempts} ` +
    `(${code}): ${failure.reason} — the stack this slot runs will not be reclaimed ` +
    'until that is fixed'
  );
}
