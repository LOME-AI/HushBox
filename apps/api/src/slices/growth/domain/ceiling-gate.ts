/**
 * The one implementation of the membership-ceiling gate, embedded verbatim by
 * every script that counts a set under a ceiling.
 *
 * `addUnderCeiling(setKey, member, ceiling, overflowKey, field, ttl)` answers
 * `admitted, latched, added` — whether the member was taken, whether this call
 * is the one that raised the bucket's flag for that set, and whether the add
 * was new.
 *
 * Both tests run BEFORE the add, and they are the reason this is a script
 * rather than a sequence of commands: a `SCARD` after a `SADD` has already
 * admitted the member it was meant to refuse, and split across round trips it
 * answers about a set that has moved on.
 *
 * Past the ceiling the member is turned away and the set's own name is latched
 * on the bucket's overflow hash, which is the field the rollup copies onto the
 * row so the dashboard states the count as a floor. `HSETNX` is what makes the
 * latch idempotent across the rest of the bucket.
 *
 * THE LATCH IS THE REFUSAL, never the ceiling being reached. A set holding
 * exactly its ceiling turned nobody away, so its count is exact, and a flag
 * there would print an exact figure with a trailing `+`. A latch whose reader
 * is an alert rather than a mark on a count fires where it FILLS instead; the
 * reader decides the edge, and the mint budget's own gate is written that way
 * for that reason.
 *
 * The membership test ahead of the cardinality test is also what keeps a
 * member the set already holds counting once the set is full: a returning
 * member raises no flag, because nothing it did was cut off.
 *
 * THE STATEMENT OF RECORD FOR HOW LONG A VALUE WRITTEN HERE IS HELD; the
 * modules that write and read these keys name this gate for the answer rather
 * than restate it, because copies of one fact drift apart.
 *
 * `EXPIRE` on whichever key the call wrote — the set on the admitted branch,
 * the overflow hash on the refused one — so neither branch leaves the key it
 * wrote without an expiry. The expiry rides the WRITE, never the bucket: a key
 * is held for the window measured from the last call that wrote it, never from
 * the bucket it is named for and never from a member's own insertion. A set's
 * window restarts on every call this gate admits, including one whose member
 * the set already held — the add is a no-op, the expiry is not — so a member
 * outlives its own arrival by as long as its set goes on being written.
 *
 * The window's length is `GROWTH_REDIS_TTL_SECONDS`
 * (`apps/api/src/lib/redis/growth-keys.ts`), passed in as `ttl`.
 */
export const CEILING_GATE_LUA = `
local function addUnderCeiling(setKey, member, ceiling, overflowKey, field, ttl)
  if redis.call('SISMEMBER', setKey, member) == 0
     and redis.call('SCARD', setKey) >= ceiling then
    local latched = redis.call('HSETNX', overflowKey, field, '1') == 1
    redis.call('EXPIRE', overflowKey, ttl)
    return false, latched, false
  end

  local added = redis.call('SADD', setKey, member) == 1
  redis.call('EXPIRE', setKey, ttl)
  return true, false, added
end
`;
