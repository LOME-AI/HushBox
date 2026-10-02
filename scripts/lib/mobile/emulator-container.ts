import { execa } from 'execa';
import { composeProjectName } from '../cli/worktree.js';
import { currentRunId, readOwnership } from '../claims/ownership.js';
import type { Ownership } from '../claims/ownership.js';

/**
 * What a shard's emulator container is called, and the one place anything is
 * allowed to remove one.
 *
 * The emulator is started by a direct `docker run` outside the compose project,
 * so no compose teardown reaches it and the name is the whole of its identity.
 * A name that carried only the shard was therefore minted identically by every
 * checkout on the machine, while the adb port of that same shard came from the
 * slot-scoped allocator — two derivations of one pair that disagreed, so two
 * checkouts got disjoint ports and one container, and each destroyed the
 * other's emulator on sight.
 */

/**
 * The container a shard's emulator runs under, for a checkout holding `slot`.
 *
 * Named after that slot's compose project so it is the same derivation as the
 * port, and so it carries the prefix the unmanaged-container reclaim scans for.
 * The shard is the allocator's lane, so name and port move together.
 */
export function emulatorContainerName(slot: number, shard: number): string {
  return `${composeProjectName(slot)}-emulator-shard-${String(shard)}`;
}

/** What a pass established about a container found — or not found — under a name. */
type EmulatorContainerVerdict = 'absent' | 'own' | 'expired' | 'held' | 'unowned' | 'unknown';

interface EmulatorContainerOutcome extends Assessment {
  readonly removed: boolean;
}

interface RemoveRequest {
  readonly name: string;
  readonly registryDir?: string | undefined;
}

/** Whether a container carries this exact name. Anchored: a prefix is a different container. */
async function containerExists(name: string): Promise<boolean> {
  const found = await execa('docker', [
    'ps',
    '-a',
    '--filter',
    `name=^${name}$`,
    '--format',
    '{{.Names}}',
  ]);
  return found.stdout.trim() !== '';
}

interface Assessment {
  readonly verdict: EmulatorContainerVerdict;
  /** Why it was left standing, for the caller to print or to fail with. */
  readonly spared: string | undefined;
}

/**
 * Which of the states a container found under this name is in.
 *
 * A run's own container is settled first, and is the one case an unread foreign
 * record may not block: this run read its own claim, so nothing is being
 * guessed, and blocking would leak the emulator it is tearing down. Everything
 * else waits on that record, the positively-dead owner included — the resource
 * at stake is a booted emulator, and a run left to reclaim it on its next
 * invocation loses nothing.
 */
function assess(name: string, ownership: Ownership): Assessment {
  const owner = ownership.resourceOwner('container', name);
  const state = ownership.stateOfResource('container', name);

  if (owner !== undefined && state === 'owned-live') {
    if (owner.runId === currentRunId()) return { verdict: 'own', spared: undefined };
    return {
      verdict: 'held',
      spared:
        `Leaving ${name} in place — live run ${owner.runId} (${owner.command}) recorded it, ` +
        'so it is another run’s emulator.',
    };
  }

  if (ownership.unreadLiveRuns.length > 0) {
    const named = ownership.unreadLiveRuns.map((found) => found.runId).join(', ');
    return {
      verdict: 'unknown',
      spared:
        `Leaving ${name} in place — the record of live run ${named} could not be read, so ` +
        'nothing here can tell it from a container that run is using.',
    };
  }

  if (state === 'owned-expired') return { verdict: 'expired', spared: undefined };
  return {
    verdict: 'unowned',
    spared:
      `Leaving ${name} in place — no claim, live or expired, names the run that started it. ` +
      'Classify everything with `pnpm dev:clean --dry-run`.',
  };
}

/**
 * Removes the container under `name` when ownership licenses it, and says what
 * it established when it does not.
 *
 * The world is scanned before the registry is read, never after: a container
 * created between the two would be classified against a registry predating its
 * claim, and a claim is always written before the thing it names is created, so
 * the later reading covers everything the earlier scan found.
 */
export async function removeEmulatorContainer(
  request: RemoveRequest
): Promise<EmulatorContainerOutcome> {
  if (!(await containerExists(request.name))) {
    return { verdict: 'absent', removed: false, spared: undefined };
  }

  const ownership = await readOwnership(request.registryDir);
  const assessment = assess(request.name, ownership);
  if (assessment.spared !== undefined) return { ...assessment, removed: false };

  await execa('docker', ['rm', '-f', request.name], { stdio: 'inherit' });
  return { ...assessment, removed: true };
}
