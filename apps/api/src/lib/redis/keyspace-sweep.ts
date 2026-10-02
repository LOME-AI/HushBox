import type { Redis } from '@upstash/redis';

/**
 * SCAN `count` hint for one sweep step. The walk runs inside Redis, so this
 * bounds how much one step blocks the server rather than how many round trips
 * the sweep costs — that number is one, whatever the keyspace holds.
 */
const SWEEP_SCAN_COUNT = 1000;

/**
 * How many keys one `DEL` inside the script takes. Lua's `unpack` expands a
 * table onto the call stack, which a whole page of a large keyspace can
 * overflow; a page is deleted in batches of this size instead.
 */
const SWEEP_DELETE_BATCH = 256;

/**
 * Walks each pattern in `KEYS` and deletes everything it reaches, answering how
 * many keys went.
 *
 * `ARGV[1]` is the SCAN count hint. The cursor loop is the same walk a client
 * would drive, moved inside the server so its iterations cost no round trips.
 *
 * The tally is `DEL`'s own reply rather than the size of the page slice handed
 * to it: SCAN may return a key more than once while the keyspace rehashes, so
 * the slice size counts removals that did not happen.
 */
const SWEEP_SCRIPT = `
local deleted = 0
local hint = ARGV[1]
for index = 1, #KEYS do
  local cursor = '0'
  repeat
    local page = redis.call('SCAN', cursor, 'MATCH', KEYS[index], 'COUNT', hint)
    cursor = page[1]
    local matched = page[2]
    for start = 1, #matched, ${String(SWEEP_DELETE_BATCH)} do
      local stop = math.min(start + ${String(SWEEP_DELETE_BATCH - 1)}, #matched)
      deleted = deleted + redis.call('DEL', unpack(matched, start, stop))
    end
  until cursor == '0'
end
return deleted
`;

/**
 * Deletes every key the given globs reach, in ONE Redis round trip.
 *
 * The walk is the cost this exists to remove: driven from the client, a glob
 * costs one round trip per SCAN page, so the price of clearing a fixed set of
 * buckets rises with every unrelated key in the database — a per-caller cost
 * that scales with global state. Inside the script the cursor loop is
 * server-side, so a caller pays one round trip whatever the keyspace holds.
 *
 * THE PATTERNS RIDE IN `KEYS`, NOT IN `ARGV`, and that is load-bearing rather
 * than stylistic. The vitest harness scopes a run's keys by rewriting them on
 * the wire (`scripts/lib/vitest/redis-scope.ts`), reaching a script only
 * through the keys it declares; a pattern passed as an argument is invisible
 * there, so the walk would leave this run's scope and delete what every
 * concurrent run had written. Declared as keys, each pattern is scoped exactly
 * as the client-driven `SCAN`'s `MATCH` was, and everything the script reaches
 * is reachable only beneath a scoped pattern. It is the one documented
 * departure from the rule `redisEval` states in
 * `apps/api/src/lib/redis/operations.ts` — that `keys` names every key a script
 * touches — and it answers that rule's purpose by the same mechanism.
 *
 * A glob is not a registry key and cannot be one, so this stays out of the
 * typed-operation seam: the callers are the dev reset endpoints, whose targets
 * are namespaces carrying identities no request names. Those routes 404 in
 * production, which is what keeps the departure contained — a clustered Redis
 * routes a script by the slots its declared keys hash to, and a glob hashes to
 * a slot it does not describe.
 */
export async function deleteKeysMatching(
  redis: Redis,
  patterns: readonly string[]
): Promise<number> {
  // A script declaring no key is outside the run scoping above, so an empty
  // sweep that still ran would walk the whole shared keyspace to match nothing.
  if (patterns.length === 0) return 0;
  const deleted = await redis.eval(SWEEP_SCRIPT, [...patterns], [String(SWEEP_SCAN_COUNT)]);
  if (typeof deleted !== 'number') {
    throw new TypeError(
      `redis keyspace sweep: the script answered ${typeof deleted}, not a count of deleted keys`
    );
  }
  return deleted;
}
