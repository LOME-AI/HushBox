/**
 * The admission Lua sources. The repo file IS the pin: the client derives the
 * script SHA at first use and runs EVALSHA with an EVAL fallback on NOSCRIPT,
 * so the canonical source here is what always executes.
 *
 * Number-precision note: Lua 5.1 numbers are doubles — exact integers up to
 * 2^53 ≈ $9.007M in nano-USD. User-wallet magnitudes never approach that
 * (admission runs only against user wallets; house-account aggregates never
 * enter Redis), and the ledger — not this advisory hold state — is the
 * durable money truth.
 */

/**
 * The one implementation of the hold format/expiry rule. Hold-hash values are
 * `"{amount}:{expiresAtMs}"` strings parsed ONLY inside Lua — a TypeScript
 * re-parse would be a second implementation that could drift. The function
 * works over any hold hash (wallet or budget scope): it sums the still-active
 * holds, counts them, and lazily prunes expired entries (recovery is
 * in-mechanism — no sweeper). Embedded verbatim by every script that reads
 * holds; callers pass the evaluation-time `now` (ARGV layouts differ).
 */
export const ACTIVE_HOLDS_LUA = `
local function activeHolds(key, now)
  local fields = redis.call('HGETALL', key)
  local sum = 0
  local count = 0
  for i = 1, #fields, 2 do
    local sep = string.find(fields[i + 1], ':', 1, true)
    local held = tonumber(string.sub(fields[i + 1], 1, sep - 1))
    local expires = tonumber(string.sub(fields[i + 1], sep + 1))
    if expires <= now then
      redis.call('HDEL', key, fields[i])
    else
      sum = sum + held
      count = count + 1
    end
  end
  return sum, count
end
`;

/**
 * Atomic admission check-and-add over the HOLDS state, gated on the snapshot
 * the balance was priced from.
 *
 * KEYS[1] wallet snapshot · KEYS[2] wallet holds hash · KEYS[3..] budget scope
 * hashes. ARGV: holdId, estimate, nowMs, holdTtlSeconds, concurrentRunCap,
 * effectiveSpendable, applyBalanceCheck (1|0), snapshotSeq, walletSeq, then one
 * remaining-budget per scope key (same order).
 *
 * The spendable-funds rule (`balance + paid cushion`, free/unknown → raw
 * balance) is computed ONCE in TypeScript by `spendableFundsNanoUsd` and passed
 * in as `effectiveSpendable`; this script never re-derives it. That balance is
 * read before this section, so the script answers `'stale'` unless the stored
 * snapshot's `ledgerSeq` still equals `snapshotSeq`, the sequence the balance
 * came from, and is at most `walletSeq`, the sequence read before the scope
 * rows. A release removes a hold only together with a snapshot that carries
 * its charge ({@link SETTLED_RELEASE_SCRIPT}), so a matching sequence means no
 * released hold's charge is missing from the balance, and no such charge is
 * missing from the scope rows either: every charge advances the wallet sequence
 * in the same transaction as its scope spends. An absent snapshot is stale too.
 *
 * Every check that reads-and-writes mutable Redis state — the active-holds sum,
 * the concurrent-run cap, and each per-scope check-and-add — stays inside this
 * atomic section, because those are the parts that race between concurrent
 * admissions.
 *
 * `applyBalanceCheck` is 0 for free wallets (no balance gate; the daily
 * allowance rides in as a budget scope) and 1 for paid/unknown wallets, so a
 * stale/untyped snapshot still fails closed.
 *
 * Returns 'stale' | 'run-cap' | 'insufficient-balance' | 'admitted', or
 * `'budget-exceeded:<index>'` where the index is the refused scope's ZERO-BASED
 * position in the caller's `budgets` — KEYS[i] and ARGV[i + 7] are both built
 * from that array at one site, so `i - 3` names the scope that bound and the
 * caller resolves its level from its own array rather than by decoding an id.
 * Expired holds are pruned lazily on every pass; the hold is written to the
 * wallet hash AND every scope hash only after every check passes, so N racers
 * can never jointly over-admit.
 */
export const ADMISSION_SCRIPT = `
local estimate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4]) * 1000
local effectiveSpendable = tonumber(ARGV[6])
local applyBalanceCheck = tonumber(ARGV[7])
local snapshot = redis.call('GET', KEYS[1])
if not snapshot then return 'stale' end
local storedSeq = tonumber(cjson.decode(snapshot).ledgerSeq)
if storedSeq ~= tonumber(ARGV[8]) then return 'stale' end
if storedSeq > tonumber(ARGV[9]) then return 'stale' end
${ACTIVE_HOLDS_LUA}
local heldSum, heldCount = activeHolds(KEYS[2], now)
if heldCount >= tonumber(ARGV[5]) then return 'run-cap' end
if applyBalanceCheck == 1 and effectiveSpendable - heldSum < estimate then return 'insufficient-balance' end
for i = 3, #KEYS do
  local remaining = tonumber(ARGV[i + 7])
  local scopeSum = activeHolds(KEYS[i], now)
  if remaining - scopeSum < estimate then return 'budget-exceeded:' .. (i - 3) end
end

local value = ARGV[2] .. ':' .. string.format('%.0f', now + ttlMs)
for i = 2, #KEYS do
  redis.call('HSET', KEYS[i], ARGV[1], value)
  redis.call('PEXPIRE', KEYS[i], ttlMs, 'GT')
  redis.call('PEXPIRE', KEYS[i], ttlMs, 'NX')
end
return 'admitted'
`;

/**
 * Read-only holds readout over N hold hashes (wallet or budget scope), for
 * the served-affordability endpoints. KEYS[1..N] hold hashes; ARGV[1] nowMs.
 * Returns one entry per key: the active-hold sum as a `%.0f`-formatted string
 * (full 2^53 precision — a raw Lua number reply would be truncated to an
 * integer by Redis). The shared fragment's count is deliberately dropped from
 * the reply — no served surface consumes it (the run cap is enforced solely
 * inside ADMISSION_SCRIPT). "Read-only" means it never adds holds; it still
 * prunes expired entries via the shared fragment, exactly like admission (the
 * one lazy-prune mechanism).
 */
export const HOLDS_READ_SCRIPT = `
local now = tonumber(ARGV[1])
${ACTIVE_HOLDS_LUA}
local out = {}
for i = 1, #KEYS do
  local sum = activeHolds(KEYS[i], now)
  out[#out + 1] = string.format('%.0f', sum)
end
return out
`;

/**
 * Daily trial-spend increment — the trial policy's cumulative Sybil ceiling.
 *
 * Unlike {@link ADMISSION_SCRIPT} there is NO wallet and NO reservation: the
 * counter is a single cumulative total fed by each trial run's ACTUAL provider
 * cost at settlement. It folds this run's cost into the day's counter atomically
 * with anchoring the counter's expiry to the next UTC midnight (NX — set once,
 * never extended, no reset job), and reports the ONE increment that crosses the
 * cap so a human is alerted exactly once per day.
 *
 * KEYS[1] daily-spend counter. ARGV: amount (nano-USD decimal string, never a
 * JS number — money stays integer across the wire), cap (nano-USD), ttlSeconds.
 * Crossing is computed from the atomic pre/post values of THIS increment, so
 * exactly one increment per day satisfies `pre < cap <= post`. Returns
 * `<crossed|below>:<total>` — a non-numeric prefix so the total round-trips as
 * a string (never parsed back into a lossy JS number), read as a bigint.
 */
export const TRIAL_SPEND_INCREMENT_SCRIPT = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])
local total = redis.call('INCRBY', key, ARGV[1])
redis.call('EXPIRE', key, ttlSeconds, 'NX')
local status = 'below'
if total >= cap and (total - amount) < cap then status = 'crossed' end
return status .. ':' .. string.format('%.0f', total)
`;

/**
 * The one implementation of the snapshot compare-and-set: writes `payload`
 * only when `seq` is newer than the stored snapshot's `ledgerSeq`, so two
 * racing writers can never regress the snapshot to an older balance. Returns 1
 * when written, 0 when the stored snapshot was as new or newer. Embedded
 * verbatim by every script that writes the snapshot.
 */
export const SNAPSHOT_CAS_LUA = `
local function casSnapshot(key, payload, seq, ttlSeconds)
  local current = redis.call('GET', key)
  if current and tonumber(cjson.decode(current).ledgerSeq) >= tonumber(seq) then
    return 0
  end
  redis.call('SET', key, payload, 'EX', ttlSeconds)
  return 1
end
`;

/**
 * Snapshot write-through. KEYS[1] wallet snapshot. ARGV: the snapshot JSON, its
 * ledgerSeq, TTL seconds. Returns 1 when written, 0 when the stored snapshot
 * was as new or newer.
 */
export const SNAPSHOT_CAS_SCRIPT = `
${SNAPSHOT_CAS_LUA}
return casSnapshot(KEYS[1], ARGV[1], ARGV[2], ARGV[3])
`;

/**
 * A run's release: writes the wallet's committed snapshot through and removes
 * the run's hold, in one atomic step. Because a release never removes a hold
 * without a snapshot at least as new as its run's charge, admission's sequence
 * check ({@link ADMISSION_SCRIPT}) never pairs a pre-charge balance with a hold
 * the release removed. A hold that expires instead (its TTL, or the lazy prune
 * in {@link ACTIVE_HOLDS_LUA}) goes with no snapshot write; the snapshot then
 * stands until a newer write-through replaces it or its TTL lapses, after which
 * admission bootstraps from Postgres.
 *
 * KEYS[1] wallet snapshot · KEYS[2] wallet holds hash · KEYS[3..] budget scope
 * hashes. ARGV: the snapshot JSON, its ledgerSeq, TTL seconds, holdId.
 */
export const SETTLED_RELEASE_SCRIPT = `
${SNAPSHOT_CAS_LUA}
casSnapshot(KEYS[1], ARGV[1], ARGV[2], ARGV[3])
for i = 2, #KEYS do
  redis.call('HDEL', KEYS[i], ARGV[4])
end
return 1
`;
