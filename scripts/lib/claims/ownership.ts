import path from 'node:path';
import { canonicalPath } from '../canonical-path.js';
import { RUN_CLAIM_ENV, addResource, enumerateRegistry, unreadLiveRuns } from './registry.js';

/**
 * The one ownership question every reclaimer asks, and the one place it is
 * answered: given a resource found in the world, which of the three states is
 * it in — held by a run that is still alive, held by a run that is not, or held
 * by nothing at all.
 *
 * The states carry three different verdicts and only the middle one licenses
 * destruction: *owned-live* is never touched, *owned-expired* is culled, and
 * *unowned* is reported and left standing. A reclaimer that cannot tell them
 * apart has to guess, and the guesses this replaces — a name that looks like
 * ours, an age past a threshold — cannot tell a live sibling's database or
 * container from a dead one's.
 *
 * Liveness is never inferred here: the state comes from the registry, whose
 * predicate is an advisory lock the kernel releases when its holder dies. No
 * timestamp, TTL or heartbeat enters this module.
 *
 * One enumeration answers a whole pass. That is not only cheaper — a run that
 * finishes mid-pass has its record removed before its lock is released, so a
 * claim seen in one enumeration may be absent from the next, and a reclaimer
 * that re-enumerated between reading and dropping would act on two worlds.
 */

export type OwnershipState = 'owned-live' | 'owned-expired' | 'unowned';

type RegistryReading = Awaited<ReturnType<typeof enumerateRegistry>>;
type EnumeratedClaim = RegistryReading['claims'][number];

/**
 * A live run whose record this reading could not make sense of. Its lock
 * answered, so the run is as present as any other; the record is what would
 * have said which resources are its own, and it said nothing.
 */
type UnreadRun = RegistryReading['unreadable'][number];

/** What a claim is called in a report line: the owning run's own record. */
type ResourceOwner = EnumeratedClaim['claim'];

type OwnedResource = Parameters<typeof addResource>[0];
type ResourceKind = OwnedResource['kind'];

export interface Ownership {
  /**
   * State of the run named by `runId`, for a resource carrying its owner in its
   * own name.
   *
   * A run the registry has no record of but does have a lock file for is one
   * that ended: *owned-expired*, and its leftovers are culled. Only a run the
   * registry has never held at all is *unowned* — a human's file, a foreign
   * process, the thing that must be reported and left standing.
   */
  stateOfRun(runId: string | null | undefined): OwnershipState;
  /** State of a resource its owning run recorded against its claim. */
  stateOfResource(kind: ResourceKind, id: string): OwnershipState;
  /** The run that recorded this resource, for a report line. */
  resourceOwner(kind: ResourceKind, id: string): ResourceOwner | undefined;
  /**
   * The live runs whose records this reading could not read.
   *
   * It is on the answer rather than beside it because the three states above
   * are only ever the states the records that WERE read put a resource in. A
   * caller whose verdict on `unowned` is to destroy — as against reporting it
   * and leaving it standing — is deciding the fate of something one of these
   * runs may be using, so it has to read this too. Empty is the ordinary
   * answer and the only one that makes `unowned` mean what it says.
   */
  readonly unreadLiveRuns: readonly UnreadRun[];
}

/**
 * The key both sides of the question pass through: the one that indexes a
 * claim's recorded resources and the one that looks a resource up. A directory
 * is the only kind whose id is a path, and a directory reached through a
 * symlink has two absolute spellings — recorded under one and asked about
 * under the other, a live run's resource reads as owned by nobody, which is
 * the verdict that licenses destroying it. Canonicalising here rather than at
 * each recorder is what makes the two sides agree whichever spelling either
 * used, records written before this existed included.
 */
function resourceKey(kind: ResourceKind, id: string): string {
  // The space is what keeps two kinds apart: a kind is one word from a closed set.
  return `${kind} ${kind === 'directory' ? canonicalPath(id) : id}`;
}

function lookup(
  map: Map<string, EnumeratedClaim>,
  key: string | null | undefined
): EnumeratedClaim | undefined {
  return key === null || key === undefined ? undefined : map.get(key);
}

/** Reads the registry once and answers every ownership question from that reading. */
export async function readOwnership(registryDir?: string): Promise<Ownership> {
  const reading = await enumerateRegistry(registryDir);
  const claims = reading.claims;
  const byRun = new Map<string, EnumeratedClaim>();
  const byResource = new Map<string, EnumeratedClaim>();
  const ended = new Set(reading.endedRuns);

  /**
   * A run's record is removed on its way out, so a resource still standing
   * afterwards has nothing left naming its owner. The lock file is what remains,
   * and it is the whole difference between the two answers here: a run the
   * registry once held is over and its leftovers are culled, while a run it has
   * never held is what an unowned resource means and is left where it is.
   *
   * This is the case a claim holder that outlives its own child produces. The
   * child mints a resource and is killed; the holder sees an ordinary child exit
   * and finishes normally, taking the record with it. Nothing about the resource
   * changed — only whether the record naming it outlived it.
   */
  function stateOfRun(runId: string | null | undefined): OwnershipState {
    const found = lookup(byRun, runId);
    if (found !== undefined) return found.state;
    return runId !== null && runId !== undefined && ended.has(runId) ? 'owned-expired' : 'unowned';
  }

  function index(found: EnumeratedClaim): void {
    byRun.set(found.claim.runId, found);
    for (const resource of found.claim.resources) {
      byResource.set(resourceKey(resource.kind, resource.id), found);
    }
  }

  // Expired first, live second, so a live claim is the last writer for any id
  // two claims name. An id can be reissued once its first holder dies, and the
  // run that reissued it is the one still able to be harmed.
  for (const found of claims) if (found.state === 'owned-expired') index(found);
  for (const found of claims) if (found.state === 'owned-live') index(found);

  return {
    stateOfRun: (runId) => stateOfRun(runId),
    stateOfResource: (kind, id) => lookup(byResource, resourceKey(kind, id))?.state ?? 'unowned',
    resourceOwner: (kind, id) => lookup(byResource, resourceKey(kind, id))?.claim,
    unreadLiveRuns: unreadLiveRuns(reading),
  };
}

/**
 * The run this process belongs to, or null when it holds no claim. The registry
 * carries the run's directory in the environment and names that directory after
 * the run, so the id is its last segment.
 */
export function currentRunId(): string | null {
  const runDir = process.env[RUN_CLAIM_ENV];
  if (runDir === undefined || runDir === '') return null;
  return path.basename(runDir);
}

/**
 * Records a resource against the enclosing run's claim, refusing when there is
 * no claim to record it against. Claim before you create: a claim naming a
 * resource that was never created is harmless, and the reverse order produces
 * an orphan by construction.
 *
 * Nothing here can invent an owner for what a claim-free caller goes on to
 * create — inventing one would license the destruction this design exists to
 * prevent — so the only two honest answers are refusing and recording, and this
 * is the refusing one. It answers nothing at all, which is what keeps the
 * refusal from being read as a verdict a caller may carry on past; the registry
 * raises it.
 *
 * {@link recordOwnedResourceIfClaimed} is the other answer, for the callers
 * whose resource another mechanism accounts for. Which of the two a call site
 * spells is the whole statement of which population it is in.
 */
export async function recordOwnedResource(kind: ResourceKind, id: string): Promise<void> {
  await addResource({ kind, id });
}

/**
 * Records a resource against the enclosing run's claim where there is one, and
 * reports that it did not where there is none.
 *
 * For the caller whose resource is accounted for without a claim, which is a
 * property of that resource's kind and not a fallback available on request.
 * Each caller in that population states its own reason: the lifeline socket in
 * `scripts/lib/spawn/long-lived.ts` and the scratch container in
 * `scripts/lib/backup/drill.ts` both name what accounts for them instead, the
 * compose project is placed by its own label whether or not a claim names it,
 * and a cache generation directory falls back to the retention gate that
 * governed every generation before claims existed. Anything else uses
 * {@link recordOwnedResource} and is refused.
 */
export async function recordOwnedResourceIfClaimed(
  kind: ResourceKind,
  id: string
): Promise<boolean> {
  if (currentRunId() === null) return false;
  await addResource({ kind, id });
  return true;
}

/**
 * What a pass established about a resource it is leaving standing, in the one
 * wording every reclaimer prints.
 *
 * With every record read, *unowned* is a finding: no claim names the run that
 * created it. With one unread, it is the absence of a finding, and the line
 * names the run to go and look at instead of asserting an owner nothing here
 * could have looked for. Shared rather than restated because the difference
 * between those two is what stops a reader treating an unestablished answer as
 * a settled one, and a reclaimer that spelled it for itself printed the
 * confident half in both cases.
 */
export function unownedFinding(ownership: Ownership): string {
  const unread = ownership.unreadLiveRuns;
  if (unread.length === 0) {
    return 'unowned — no claim, live or expired, names the run that created it, so it is left standing';
  }
  return (
    `unattributed — the record of live run ${unread.map((found) => found.runId).join(', ')} ` +
    'could not be read, so a claim on it may exist and be unreadable, and it is left standing'
  );
}

interface ReapPass<T> {
  /** What this pass reclaims, for the line it prints when it skips. */
  readonly what: string;
  /** Every id of this kind present in the world right now. */
  readonly scan: () => Promise<readonly string[]>;
  readonly reap: (present: readonly string[], ownership: Ownership) => Promise<T>;
  readonly registryDir?: string | undefined;
  readonly attempts?: number | undefined;
}

const REAP_ATTEMPTS = 3;

/**
 * Runs one reclamation pass over a world that held still while it was read.
 *
 * Scanning the world and reading the registry cannot be one atomic act, so a
 * resource created between them would be classified against a registry that
 * predates its claim — and would look unowned to a pass that could otherwise
 * destroy it. Re-scanning afterwards and restarting on anything new closes that
 * window: only an *appearance* invalidates a reading, since a resource that
 * vanished is one no reclaimer can harm.
 *
 * A world that never settles ends the pass with a printed line and no result:
 * housekeeping never fails the command it is housekeeping for, and every
 * resource it did not classify is still there for the next run to reclaim.
 */
export async function reapPass<T>(pass: ReapPass<T>): Promise<T | undefined> {
  const attempts = pass.attempts ?? REAP_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await pass.scan();
    const ownership = await readOwnership(pass.registryDir);
    const after = await pass.scan();

    const seen = new Set(before);
    if (after.every((id) => seen.has(id))) return pass.reap(before, ownership);
  }

  console.warn(
    `Skipped reclaiming ${pass.what}: a resource appeared during each of ` +
      `${String(attempts)} passes, so none of them read a world that held still. ` +
      `Nothing was reclaimed, and the next run reclaims what this one left.`
  );
  return undefined;
}
