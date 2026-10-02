import { CEILING_GATE_LUA } from './ceiling-gate.js';

/**
 * The wire strides, declared once and interpolated into BOTH sides.
 *
 * The script reads its per-op entries by offset and the builder writes them by
 * offset, so a stride written as a literal on each side is a mirrored constant
 * that drift eventually wins — silently, because a wrong stride reads a
 * neighbouring op's value rather than failing.
 *
 * What this pins is the STRIDE, not the field ORDER: the positions within an
 * op still have to agree by reading, and nothing here would catch two fields
 * being swapped. The integration tests against a real Redis hold that half,
 * because a swap writes the wrong key.
 */
export const BEACON_WIRE = {
  /** `KEYS` entries before the ops: the landing key, the two overflow hashes, and the address's mint set and its budget latch. */
  fixedKeys: 5,
  /** `KEYS` entries per op: its natural set, its folded set, its index set. */
  keysPerOp: 3,
  /** `ARGV` entries before the ops: ttl, set ceiling, member, assumed landing, path, op count, mint ceiling. */
  fixedArgs: 7,
  /** `ARGV` entries per op. */
  argsPerOp: 10,
} as const;

/**
 * The reply's first field: what became of the beacon.
 *
 * Four spellings over two outcomes. A beacon is counted or it is dropped, and
 * each outcome has a second spelling saying "this is the one worth telling an
 * operator about": `counted-full` is the admitted beacon whose identity filled
 * the address's daily budget, and `dropped-first` a refusal that met a full
 * budget no latch had reported yet. Both spellings write the one day latch, so
 * the caller reports an address's budget once rather than once per spelling.
 *
 * Words rather than digits because the HTTP client JSON-parses what the script
 * returns: a reply of `'0'` arrives as the NUMBER zero and fails the string
 * schema, while a reply carrying flags after it stays a string. A status that
 * only survives when something follows it is a status that works until the
 * ordinary case.
 */
export const BEACON_STATUS = {
  counted: 'counted',
  countedFull: 'counted-full',
  capped: 'dropped',
  cappedFirst: 'dropped-first',
} as const;

/**
 * The whole of one beacon's writes, as one Lua script.
 *
 * Three properties force a script rather than a sequence of commands.
 *
 * **The ceilings have to be checked before the add, atomically.** A `SCARD`
 * after a `SADD` is self-contradictory — the member it was meant to refuse is
 * already in — and split across round trips the check answers about a set that
 * has moved on. Redis blocks everything else for a script's duration, so the
 * reads, the comparisons and the writes below observe and leave one state.
 *
 * **Cost.** The Upstash transport is one round trip per command and a page view
 * issues twenty of them; at a million page views a month that is the difference
 * between a rounding error and a line item.
 *
 * **The reply is the only thing that can say a flag is new.** A Worker holds no
 * memory between requests, so "report this overflow once" has to be answered by
 * the store: `HSETNX` on the bucket's overflow hash is both the flag the rollup
 * copies onto a row and the latch that makes the alert fire once per set per
 * bucket. A second key for the latch would be a backup mechanism for a fact the
 * first key already holds.
 *
 * # The wire
 *
 * Every key the script touches is passed in `KEYS`, never assembled here: a key
 * built inside Lua is invisible to the test harness's per-run key scoping, so
 * it would be written outside the run that wrote it, and invisible to the key
 * registry, which is where a key's schema and lifetime are declared.
 *
 * ```
 * KEYS[1]                  the visitor's landing key for the day
 * KEYS[2], KEYS[3]         the hour and day overflow hashes
 * KEYS[4]                  the identities this address minted today
 * KEYS[5]                  the latch that reports this address's full budget once
 * KEYS[6 + 3(i-1) .. ]     per op: its natural set, its folded set, its index set
 *
 * ARGV[1] ttl seconds      ARGV[2] set ceiling      ARGV[3] the member
 * ARGV[4] assumed landing  ARGV[5] this path        ARGV[6] number of ops
 * ARGV[7] mint ceiling
 * ARGV[8 + 10(i-1) .. ]    per op: enabled, dep, record, hasIndex, index ceiling,
 *                          natural index member, folded index member,
 *                          overflow grain, natural overflow field, folded field
 * ```
 *
 * # The mint gate
 *
 * The member is a keyed hash over the address and the user agent, and the user
 * agent is the sender's to vary without limit — so the address alone bounds
 * nothing, and one address could open a new identity per beacon until the day's
 * visitor set hit its own ceiling. The gate is the same shape as the index
 * ceiling below it, a membership test then a cardinality test before any write,
 * and it runs FIRST: past the ceiling an identity the address has not already
 * minted is refused ahead of the landing claim and of every set, because a
 * partial write files a real page view under an identity the count is refusing.
 * An identity the address minted before the ceiling goes on counting.
 *
 * The day latch is written where the budget FILLS — by the admitted add that
 * brings the set to the ceiling — and also by a refusal that meets a full
 * budget the latch does not already cover. `SET NX` is what makes those two
 * one report. Writing it at the fill is what sees a sender sized at exactly
 * the budget: it is refused nothing, so a latch written only by a refusal
 * would leave it unmarked though it has taken its address's whole daily
 * budget. This write costs a command only on the beacon that fills.
 *
 * An op's `dep` names what must already hold for it to run — `lh` and `ld` are
 * the landing sets, which need this to be the visitor's first sight today AND
 * the same grain's view add to have been admitted; `rm` is the reach set, which
 * needs the landing path the caller built its key from to be the one that
 * actually won the claim. `record` is the other half of the same wiring: the
 * day visitor set records whether the add was NEW (that is first sight), and
 * each view set records whether it was ADMITTED.
 *
 * The reply is the status above, then the newly-latched overflow flags, joined
 * by the unit separator — a delimited string rather than a table, because Redis
 * renders table replies as arrays whose element types are lost across the HTTP
 * client, and because every entry it can carry ends in a set name, which may
 * contain any of `:`, `/`, `.` and `-`.
 *
 * Each entry is the grain then the set name, because a flag is per set per
 * BUCKET: one page view can fill the same set at both grains, and reporting
 * the name alone would say the same thing twice with no way to tell which
 * bucket either half meant.
 *
 * Do not add a `#!lua` shebang: declaring a script version removes the default
 * cross-slot key allowance these keys rely on.
 */
export const BEACON_SCRIPT = String.raw`
local ttl = tonumber(ARGV[1])
local setCeiling = tonumber(ARGV[2])
local member = ARGV[3]
local assumedLanding = ARGV[4]
local currentPath = ARGV[5]
local ops = tonumber(ARGV[6])
local mintCeiling = tonumber(ARGV[7])

local landingKey = KEYS[1]
local overflow = { h = KEYS[2], d = KEYS[3] }
local mintKey = KEYS[4]
local mintCappedKey = KEYS[5]

local mintFilled = false
${CEILING_GATE_LUA}

if redis.call('SISMEMBER', mintKey, member) == 0 then
  local minted = redis.call('SCARD', mintKey)
  if minted >= mintCeiling then
    if redis.call('SET', mintCappedKey, '1', 'NX', 'EX', ttl) then
      return '${BEACON_STATUS.cappedFirst}'
    end
    return '${BEACON_STATUS.capped}'
  end
  redis.call('SADD', mintKey, member)
  redis.call('EXPIRE', mintKey, ttl)
  if minted + 1 >= mintCeiling
     and redis.call('SET', mintCappedKey, '1', 'NX', 'EX', ttl) then
    mintFilled = true
  end
end

local dayFirst = false
local admittedView = { vh = false, vd = false }
local landingMatches = false
local reply = { mintFilled and '${BEACON_STATUS.countedFull}' or '${BEACON_STATUS.counted}' }

if currentPath ~= '' then
  redis.call('SET', landingKey, currentPath, 'NX', 'EX', ttl)
  landingMatches = redis.call('GET', landingKey) == assumedLanding
end

for i = 1, ops do
  local k = ${String(BEACON_WIRE.fixedKeys)} + (i - 1) * ${String(BEACON_WIRE.keysPerOp)}
  local a = ${String(BEACON_WIRE.fixedArgs)} + (i - 1) * ${String(BEACON_WIRE.argsPerOp)}
  local run = ARGV[a + 1] == '1'
  local dep = ARGV[a + 2]
  local record = ARGV[a + 3]
  local hasIndex = ARGV[a + 4] == '1'
  local indexCeiling = tonumber(ARGV[a + 5])
  local indexMember = ARGV[a + 6]
  local field = ARGV[a + 9]

  if dep == 'lh' then run = run and dayFirst and admittedView.vh
  elseif dep == 'ld' then run = run and dayFirst and admittedView.vd
  elseif dep == 'rm' then run = run and landingMatches end

  if run then
    local setKey = KEYS[k + 1]
    local indexKey = KEYS[k + 3]

    if hasIndex and indexCeiling > 0
       and redis.call('SISMEMBER', indexKey, indexMember) == 0
       and redis.call('SCARD', indexKey) >= indexCeiling then
      setKey = KEYS[k + 2]
      indexMember = ARGV[a + 7]
      field = ARGV[a + 10]
    end

    local admitted, latched, added = addUnderCeiling(
      setKey, member, setCeiling, overflow[ARGV[a + 8]], field, ttl)

    if latched then reply[#reply + 1] = ARGV[a + 8] .. ':' .. field end

    if admitted then
      if hasIndex then
        redis.call('SADD', indexKey, indexMember)
        redis.call('EXPIRE', indexKey, ttl)
      end
      if record == 'first' then dayFirst = added
      elseif record ~= '' then admittedView[record] = true end
    end
  end
end

return table.concat(reply, '\31')
`;

/** The separator the reply's field list is joined on, as JavaScript spells it. */
export const BEACON_REPLY_SEPARATOR = '\u001F';
