import { z } from 'zod';
import {
  GROWTH_REDIS_KEYS,
  GROWTH_REDIS_TTL_SECONDS,
  redisEval,
} from '../../../lib/redis/index.js';
import { CEILING_GATE_LUA } from './ceiling-gate.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Variables } from '../../../lib/context/index.js';

/** The per-request Redis client as the pipeline types it. */
type RedisClient = Variables['redis'];

/** What one registration start contributes to the funnel. */
export interface RegistrationStartedCount {
  /** The UTC hour bucket the start is filed under, derived server-side from arrival. */
  readonly hour: string;
  /** The campaign tag, already resolved against the active set. */
  readonly campaign: string;
  /** The caller's day-keyed address identity in the started sets, which no other key shares. */
  readonly addressId: string;
  /**
   * True on the enumeration-defence branch, where the handshake is answered
   * for an address that already has an account. The count then lands in the
   * shadow set instead of the counted one.
   */
  readonly decoy: boolean;
}

/**
 * One start, gated and counted: the set the start belongs to, then the bucket's
 * overflow hash for the flag a refusal latches. The reply is whether THIS call
 * raised that flag — the only thing that can say a refusal is new, because a
 * Worker holds no memory between requests and `HSETNX` makes the raise happen
 * once per set per bucket.
 */
const COUNT_SCRIPT = `
local ttl = ARGV[2]
local ceiling = tonumber(ARGV[3])
${CEILING_GATE_LUA}
local _, latched = addUnderCeiling(KEYS[1], ARGV[1], ceiling, KEYS[2], ARGV[4], ttl)
if latched then return 1 end
return 0
`;

/**
 * One registration start, counted under the ceiling its caller passes, and
 * whether this call is the one that latched the bucket's overflow flag for the
 * set it wrote.
 *
 * The latch is the REFUSAL, never the ceiling being reached: the call that
 * fills the set turned nobody away, so it reports nothing, and the flag it
 * reports is per set per bucket rather than per refused address.
 *
 * The published door in `apps/api/src/slices/growth/public/funnel.ts` fixes the
 * ceiling at the shared constant, so every registration start the running
 * system takes is bounded identically; the parameter is what lets the bound
 * itself be exercised, which is why the beacon's own counter in
 * `apps/api/src/slices/growth/domain/count-beacon.ts` carries its ceilings the
 * same way — a hundred thousand addresses cannot be driven any other way.
 */
export function countRegistrationStartedUnderCeiling(
  redis: RedisClient,
  count: RegistrationStartedCount,
  ceiling: number
): ResultAsync<boolean, DomainError> {
  const set = count.decoy ? GROWTH_REDIS_KEYS.startedDecoy : GROWTH_REDIS_KEYS.started;
  return redisEval(redis, {
    script: COUNT_SCRIPT,
    reply: z.union([z.literal(0), z.literal(1)]),
    keys: [
      set.buildKey(count.hour, count.campaign),
      GROWTH_REDIS_KEYS.overflow.buildKey('h', count.hour),
    ],
    args: [
      count.addressId,
      String(GROWTH_REDIS_TTL_SECONDS),
      String(ceiling),
      set.setName(count.campaign),
    ],
  }).map((reply) => reply === 1);
}
