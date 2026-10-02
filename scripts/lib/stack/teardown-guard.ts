/**
 * The question every destructive stack path asks before it destroys anything:
 * does any run other than this one hold the slot.
 *
 * A wipe (`pnpm db:reset`, through the refusal in
 * `scripts/lib/stack/ensure-stack.ts`) and a teardown (`scripts/stack-teardown.ts`)
 * both take the slot's stack out from under whatever is running against it, and
 * stand on the same answer, so the question is asked in one place and
 * parameterised by the run the asker disregards. Their reach differs — the wipe
 * tears the compose project down with `{ volumes: true }` and takes the named
 * volumes with it, while the teardown passes no such flag and leaves them — but
 * either destruction lands on a live run. Two spellings of the question would not
 * merely disagree: whichever one read a slot as free would license it.
 *
 * **Disregarding the asker's own run is what lets the check live inside the
 * process that then destroys.** `scripts/with-env.ts` registers a run claim for
 * every invocation it wraps, so a check counting every live claim on the slot
 * counts itself and refuses always. Excluding the asker also closes the window a
 * separate checking process would open between the check and the destruction,
 * which is the hazard `scripts/with-run-claim.ts` records in its own header.
 */
import { currentRunId } from '../claims/ownership.js';
import { readSlotLiveness } from '../claims/registry.js';

/** Both halves of what the registry can say about one slot. */
type SlotLiveness = Awaited<ReturnType<typeof readSlotLiveness>>;

/**
 * The live runs on `slot` other than `disregardRunId`, in both halves of the
 * reading. A caller holding a claim of its own passes it; one holding none
 * passes null, and every live run is other.
 *
 * Both halves are answered, and a caller that calls a slot free has to find both
 * empty. A run whose record could not be read named no slot, so nothing puts it
 * on another one; its lock says it is alive; and reading its silence as an empty
 * slot takes the slot's stack out from under a run that is still working against
 * it.
 */
export async function otherRunsOnSlot(
  slot: number,
  disregardRunId: string | null,
  registryDir?: string
): Promise<SlotLiveness> {
  const liveness = await readSlotLiveness(slot, registryDir);
  return {
    claimed: liveness.claimed.filter((found) => found.runId !== disregardRunId),
    unknown: liveness.unknown.filter((found) => found.runId !== disregardRunId),
  };
}

/**
 * Refuses a teardown of `slot` while any run but this one is live on it, naming
 * what is holding it and what the operator can do about it.
 */
export async function assertSlotFreeToTearDown(slot: number, registryDir?: string): Promise<void> {
  const others = await otherRunsOnSlot(slot, currentRunId(), registryDir);
  const count = others.claimed.length + others.unknown.length;
  if (count === 0) return;

  const named = [
    ...others.claimed.map((found) => `\`${found.command}\` (pid ${String(found.pid)})`),
    ...others.unknown.map(
      (found) => `the run in ${found.runId}, whose record could not be read (${found.reason})`
    ),
  ].join(', ');
  throw new Error(
    `stack teardown: refusing to tear down slot ${String(slot)} while ${named} ` +
      `${count === 1 ? 'is' : 'are'} still live on it — a teardown removes the containers ` +
      'and networks on the slot, and with them whatever a container holds that no named ' +
      'volume backs, such as the Redis keyspace. The named volumes survive, so the Postgres ' +
      'data and the MinIO objects outlive it. Re-run once they have finished.' +
      (others.unknown.length === 0
        ? ''
        : ' A run whose record cannot be read is on no slot this can rule out, so remove its ' +
          'directory by hand once you have established that no run is using it.')
  );
}
