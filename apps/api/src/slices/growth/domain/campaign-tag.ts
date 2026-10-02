import { GROWTH_DIRECT_CAMPAIGN, GROWTH_UNKNOWN_CAMPAIGN } from '@hushbox/shared';
import { GROWTH_REDIS_KEYS, redisGet, redisSet } from '../../../lib/redis/index.js';
import { okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Variables } from '../../../lib/context/index.js';

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

interface ResolveCampaignTagArgs {
  readonly redis: RedisClient;
  /** Reads the active tags from the campaigns table. Called only when the registry has expired. */
  readonly listActiveTags: () => ResultAsync<readonly string[], DomainError>;
  /** The tag the beacon carried, already shape-validated. */
  readonly tag: string | undefined;
}

/**
 * The campaign a beacon is counted under.
 *
 * A tag is a label shared by everyone who clicked one link, never a per-person
 * identifier, and the set of live labels changes only when an operator mints or
 * archives one — so it is read from Postgres once per registry lifetime and
 * answered from Redis in between. Without that, a flood of beacons would be a
 * flood of database reads on an unauthenticated route.
 *
 * A read that fails answers an error rather than a tag. The alternative —
 * treating an unreadable registry as "unknown" — would silently reattribute a
 * live campaign's whole traffic for the length of an outage, and the counts are
 * kept forever.
 */
export function resolveCampaignTag(args: ResolveCampaignTagArgs): ResultAsync<string, DomainError> {
  const { redis, listActiveTags, tag } = args;
  if (tag === undefined) return okAsync(GROWTH_DIRECT_CAMPAIGN);

  return redisGet(redis, GROWTH_REDIS_KEYS.activeCampaigns)
    .andThen((cached) =>
      cached === null
        ? listActiveTags().andThen((tags) =>
            redisSet(redis, GROWTH_REDIS_KEYS.activeCampaigns, [...tags]).map(() => tags)
          )
        : okAsync<readonly string[], DomainError>(cached)
    )
    .map((tags) => (tags.includes(tag) ? tag : GROWTH_UNKNOWN_CAMPAIGN));
}
