/**
 * The repo's only rate-limit counting implementation, as one Lua script. It
 * decides one request against N layers — N keys, each with its own cap and
 * window.
 *
 * The window guard runs before anything else, and it exists for the
 * non-positive case specifically, which disables the gate SILENTLY: `EXPIRE key
 * 0 NX` and any negative TTL DELETE the key rather than setting one, so every
 * increment returns 1, the count never reaches the cap, and the check answers
 * allowed forever with no error and no observable difference from a working
 * limiter. That was the one malformed input that failed OPEN. The guard is
 * written over the whole predicate anyway — non-positive, fractional and
 * unparseable alike — and returns a Redis error, so every window shape the
 * arithmetic below would mishandle joins one fail-closed path.
 *
 * A malformed cap fails closed at the comparison instead of at a guard: zero,
 * negative and NaN all refuse. So does a stored count that is not a number,
 * which errors out of the arithmetic.
 *
 * The admission test is spelled `not (spent + 1 <= cap)` rather than
 * `spent + 1 > cap`, and the two are not interchangeable: `tonumber` resolves
 * `NaN` through `strtod`, and every comparison against NaN is false, so the
 * `>` spelling reads a NaN cap as "not over the limit" and admits every
 * request against it. This spelling puts NaN on the refusing side.
 *
 * **The atomicity ground is the script's atomic execution, not any single
 * command's return value.** Redis blocks all other activity for a script's
 * duration, and Upstash additionally global-locks `EVAL`, so the reads, the
 * comparisons and the writes below observe and leave one consistent state.
 * That is what makes reading a counter and then writing it correct HERE and
 * wrong anywhere else: split across two round trips the same sequence loses
 * updates for the whole window and admits `cap × concurrency`.
 *
 * Two constraints shape the decision, and they pull opposite ways:
 *
 * - **All-or-nothing.** A request refused by one layer leaves every other
 *   layer's counter untouched. Otherwise an attacker sharing one layer's
 *   identity — an IP — drains a legitimate caller's personal budget with
 *   requests that were never admitted, recreating the hazard layering exists
 *   to prevent.
 * - **The refusing layers still advance past their caps.** A caller notifying
 *   on the crossing attempt reads `cap + 1` (the login lockout email is the
 *   live one), so a counter parked at its cap fires that notification either
 *   never or on every subsequent attempt.
 *
 * So: check every layer, then increment all of them when none refuses, or only
 * the refusing ones when some do. The refusal is attributed to the FIRST
 * refusing layer, matching a stack of mounts: a refusal short-circuits the
 * chain, so the first mount to refuse is the one that answers.
 *
 * `EXPIRE … NX` anchors a layer's window at its first attempt and never
 * extends it, so a refused attempt cannot push its own window out. `PTTL`
 * answers retry-after from the refusing layer's real remaining lifetime, and
 * runs only on the refused path — an admitted caller has nothing to wait for.
 * A `PTTL` at or below zero means that counter carries no expiry despite the
 * `EXPIRE NX` (only reachable if something stripped it in between), so
 * retry-after falls back to the layer's full window — conservative rather than
 * inviting an immediate retry.
 *
 * The reply is a fixed-arity string,
 * `<verdict>:<refusingLayer>:<count>:<retryAfterSeconds>`, rather than a Lua
 * table: Redis renders table replies as arrays whose element types are lost
 * across the HTTP client, and the existing scripts in this repo already answer
 * with delimited strings. `refusingLayer` is 1-based and zero on the admitted
 * arm, whose `count` is the highest across the layers — the number a caller
 * displays as spent — and whose retry-after is zero, which the decision type
 * drops.
 *
 * Do not add a `#!lua` shebang. On real Redis, declaring a script version
 * removes the default cross-slot key allowance the layered keys rely on.
 */
export const CONSUME_SCRIPT = `
local layers = #KEYS

for i = 1, layers do
  local windowSeconds = tonumber(ARGV[i * 2])
  if not windowSeconds or windowSeconds < 1 or windowSeconds % 1 ~= 0 then
    return redis.error_reply('rate limit window must be a positive whole number of seconds')
  end
end

local refusing = {}
local refusedLayer = 0
for i = 1, layers do
  local stored = redis.call('GET', KEYS[i])
  local spent = 0
  if stored then spent = tonumber(stored) end
  if not (spent + 1 <= tonumber(ARGV[i * 2 - 1])) then
    refusing[i] = true
    if refusedLayer == 0 then
      refusedLayer = i
    end
  end
end

local highest = 0
local crossingCount = 0
for i = 1, layers do
  if refusedLayer == 0 or refusing[i] then
    local count = redis.call('INCR', KEYS[i])
    redis.call('EXPIRE', KEYS[i], tonumber(ARGV[i * 2]), 'NX')
    if count > highest then highest = count end
    if i == refusedLayer then crossingCount = count end
  end
end

if refusedLayer == 0 then
  return 'allowed:0:' .. highest .. ':0'
end

local retryAfterSeconds = tonumber(ARGV[refusedLayer * 2])
local pttl = redis.call('PTTL', KEYS[refusedLayer])
if pttl > 0 then
  retryAfterSeconds = math.ceil(pttl / 1000)
end
return 'refused:' .. refusedLayer .. ':' .. crossingCount .. ':' .. retryAfterSeconds
`;
