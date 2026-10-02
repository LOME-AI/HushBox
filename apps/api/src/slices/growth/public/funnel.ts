import { GROWTH_CEILINGS } from '@hushbox/shared';
import { growthDayBucket, growthHourBucket } from '../../../lib/redis/index.js';
import { ResultAsync } from '../../../lib/result/index.js';
import { countRegistrationStartedUnderCeiling } from '../domain/count-registration-started.js';
import { dailyAddressId } from '../domain/visitor-hash.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Variables } from '../../../lib/context/index.js';

export { resolveCampaignTag } from '../domain/campaign-tag.js';

/** The per-request Redis client as the pipeline types it. */
type RedisClient = Variables['redis'];

/** One registration start as the identity slice has it in hand. */
export interface RegistrationStart {
  /** The key the start's address identity is derived under. */
  readonly secret: string;
  /** The caller's address as the shared resolver answered it; never written down. */
  readonly address: string;
  /** Server arrival time. The hour bucket and the day key both derive from it. */
  readonly at: Date;
  /** The campaign tag, already resolved against the active set. */
  readonly campaign: string;
  /** True on the enumeration-defence branch, which counts into the shadow set. */
  readonly decoy: boolean;
}

/**
 * Registration's one growth write, published for the identity slice to call
 * inside its own init flow.
 *
 * The step is a SET of address identities rather than a counter, because a
 * handshake replayed from one address — a double tap, a reload, a network
 * retry — is one person starting once, and only a set converges on that. The
 * identity is keyed under the day and under a derivation of its own, so it
 * reverses to no address without the key, matches no other day's, and equals
 * neither the beacon's visitor hash nor the mint family's identity: no reader
 * holding no secret can join a start to an anonymous visit.
 *
 * The decoy branch writes the same identity to a shadow set nothing reads
 * rather than skipping the write. Skipping it would make the existing-email
 * path measurably cheaper than the real one, which is a timing side channel
 * inside the very defence that exists to stop account enumeration.
 *
 * The answer is whether this start is the one the ceiling turned away first,
 * which is what lets the caller report a refusal once per set per bucket
 * instead of once per refused address.
 *
 * A caller treats the result as best-effort: registration is authentication
 * and never degrades, growth may.
 */
export function countRegistrationStarted(
  redis: RedisClient,
  start: RegistrationStart
): ResultAsync<boolean, DomainError> {
  // A platform primitive over a value already in hand: it has no failing input,
  // so it is lifted without an error mapper, and a WebCrypto defect stays the
  // exception a defect is.
  const addressId = ResultAsync.fromSafePromise(
    dailyAddressId({
      secret: start.secret,
      address: start.address,
      day: growthDayBucket(start.at),
      set: 'started',
    })
  );
  return addressId.andThen((id) =>
    countRegistrationStartedUnderCeiling(
      redis,
      {
        hour: growthHourBucket(start.at),
        campaign: start.campaign,
        addressId: id,
        decoy: start.decoy,
      },
      GROWTH_CEILINGS.set
    )
  );
}
