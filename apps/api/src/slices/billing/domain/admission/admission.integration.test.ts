import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import {
  DEADLINE_CLASSES,
  PAID_CUSHION_NANO_USD,
  runTimeBounds,
  spendableFundsNanoUsd,
} from '@hushbox/shared';
import { LOCAL_NEON_DEV_CONFIG, createDb, wallets } from '@hushbox/db';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { errAsync, fromPromise, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { sweepLeakedTestWallets } from '../../__tests__/orphan-wallet-sweep.setup.js';
import { createBillingStores } from '../../adapters/stores.js';
import { BILLING_KEYS, MAX_HOLD_TTL_SECONDS } from '../keys.js';
import { COST_CIRCUIT_MULTIPLIER, HOLD_TTL_MARGIN_SECONDS } from '../constants.js';
import { admitRun, refreshWalletSnapshot, releaseHold, writeThroughSnapshot } from './admission.js';
import type {
  AdmissionDecision,
  AdmissionDeps,
  AdmissionRequest,
  BudgetScope,
  BudgetScopeKind,
} from './admission.js';
import type { WalletType } from '../../ports/index.js';
import type { WalletSnapshotRow } from '../../ports/stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for admission tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token', retry: false });
const stores = createBillingStores();
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
const createdWalletIds: string[] = [];

async function seedWallet(
  balanceNanoUsd: bigint,
  ledgerSeq = 0n,
  type: WalletType = 'purchased'
): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId: null, type, balanceNanoUsd, ledgerSeq })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  createdWalletIds.push(id);
  return id;
}

/** The scope read admission takes: the wallet's committed sequence, then `scopes`. */
function scopesAt(
  walletId: string,
  scopes: readonly BudgetScope[] = []
): AdmissionRequest['readScopes'] {
  return () =>
    stores.readWalletSnapshot(db, walletId).map((row) => {
      if (row === null) throw new Error('scope read: the wallet does not exist');
      return { scopes, walletSeq: row.ledgerSeq };
    });
}

function request(walletId: string, overrides?: Partial<AdmissionRequest>): AdmissionRequest {
  return {
    walletId,
    holdId: crypto.randomUUID(),
    estimateNanoUsd: 100_000_000n,
    deadlineClass: 'text',
    concurrentRunCap: 10,
    readScopes: scopesAt(walletId),
    now: NOW,
    ...overrides,
  };
}

async function decide(deps: AdmissionDeps, req: AdmissionRequest): Promise<AdmissionDecision> {
  const result = await admitRun(deps, req);
  return result._unsafeUnwrap();
}

async function snapshotWritten(
  walletId: string,
  balanceNanoUsd: bigint,
  ledgerSeq: bigint
): Promise<boolean> {
  const result = await writeThroughSnapshot(redis, {
    walletId,
    balanceNanoUsd,
    ledgerSeq,
    walletType: 'purchased',
  });
  return result._unsafeUnwrap();
}

/** The wallet's committed row, read from Postgres. */
async function committedWallet(walletId: string): Promise<WalletSnapshotRow> {
  const read = await stores.readWalletSnapshot(db, walletId);
  const row = read._unsafeUnwrap();
  if (row === null) throw new Error('the wallet does not exist');
  return row;
}

/**
 * A settlement's commit as admission sees it: the wallet row moves by the charge
 * and advances its sequence, and the Redis snapshot is left as it was.
 */
async function commitCharge(walletId: string, chargeNanoUsd: bigint): Promise<bigint> {
  const row = await committedWallet(walletId);
  const ledgerSeq = row.ledgerSeq + 1n;
  await db
    .update(wallets)
    .set({ balanceNanoUsd: row.balanceNanoUsd - chargeNanoUsd, ledgerSeq })
    .where(eq(wallets.id, walletId));
  return ledgerSeq;
}

/** A settlement landing in full: its charge commits and its release writes the snapshot. */
async function settleCharge(walletId: string, chargeNanoUsd: bigint): Promise<void> {
  const ledgerSeq = await commitCharge(walletId, chargeNanoUsd);
  const row = await committedWallet(walletId);
  await snapshotWritten(walletId, row.balanceNanoUsd, ledgerSeq);
}

/** A scope read that runs `before` ahead of each read, counting the reads. */
function scopeReadAfter(
  walletId: string,
  before: (read: number) => Promise<void>
): { readonly readScopes: AdmissionRequest['readScopes']; readonly reads: () => number } {
  let reads = 0;
  return {
    readScopes: () => {
      reads += 1;
      return fromPromise(before(reads), (cause) =>
        unavailableError('test scope read', cause)
      ).andThen(() => scopesAt(walletId)());
    },
    reads: () => reads,
  };
}

async function holdPresent(hashKey: string, holdId: string): Promise<boolean> {
  return (await redis.hexists(hashKey, holdId)) === 1;
}

beforeAll(async () => {
  await sweepLeakedTestWallets(db);
});

afterAll(async () => {
  if (createdWalletIds.length > 0) {
    await Promise.all(
      createdWalletIds.map((walletId) =>
        redis.del(
          BILLING_KEYS.walletSnapshot.buildKey(walletId),
          BILLING_KEYS.walletHolds.buildKey(walletId)
        )
      )
    );
    await db.delete(wallets).where(inArray(wallets.id, createdWalletIds));
  }
  await db.$client.end();
});

describe('admitRun', () => {
  it('admits an affordable run and returns the hold readout exposing the estimate and K', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const req = request(walletId);
    const decision = await decide({ redis, db, stores }, req);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error('unreachable');
    expect(decision.hold.estimateNanoUsd).toBe(100_000_000n);
    expect(decision.hold.costCircuitMultiplier).toBe(COST_CIRCUIT_MULTIPLIER);
    expect(decision.hold.costCircuitLimitNanoUsd).toBe(500_000_000n);
    expect(decision.hold.expiresAtMs).toBe(
      NOW.getTime() + runTimeBounds('text').hardStopAfterMs + HOLD_TTL_MARGIN_SECONDS * 1000
    );
  });

  it('refuses when the balance plus cushion minus active holds cannot cover the estimate', async () => {
    // $1.20 balance + $0.50 cushion covers one $1 hold, not two.
    const walletId = await seedWallet(1_200_000_000n);
    const deps = { redis, db, stores };
    const first = await decide(deps, request(walletId, { estimateNanoUsd: 1_000_000_000n }));
    expect(first.admitted).toBe(true);
    const second = await decide(deps, request(walletId, { estimateNanoUsd: 1_000_000_000n }));
    expect(second).toEqual({ admitted: false, reason: 'insufficient-balance' });
  });

  it('never over-admits a single wallet under concurrent admission', async () => {
    // $3 balance + $0.50 cushion fits exactly three $1 holds, no fourth.
    const walletId = await seedWallet(3_000_000_000n);
    const deps = { redis, db, stores };
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        admitRun(deps, request(walletId, { estimateNanoUsd: 1_000_000_000n }))
      )
    );
    const admitted = decisions.filter((d) => d._unsafeUnwrap().admitted);
    expect(admitted).toHaveLength(3);
  });

  it('enforces the per-wallet concurrent-run cap', async () => {
    const walletId = await seedWallet(10_000_000_000n);
    const deps = { redis, db, stores };
    const first = await decide(deps, request(walletId, { concurrentRunCap: 1 }));
    expect(first.admitted).toBe(true);
    const second = await decide(deps, request(walletId, { concurrentRunCap: 1 }));
    expect(second).toEqual({ admitted: false, reason: 'run-cap' });
  });

  it('refuses when a period budget scope cannot cover the estimate', async () => {
    const walletId = await seedWallet(10_000_000_000n);
    const scope = {
      kind: 'member' as const,
      scopeId: `member:${crypto.randomUUID()}:2026-07`,
      remainingNanoUsd: 50_000_000n,
    };
    const decision = await decide(
      { redis, db, stores },
      request(walletId, { readScopes: scopesAt(walletId, [scope]) })
    );
    expect(decision).toEqual({ admitted: false, reason: 'member-budget-exceeded' });
  });

  it('counts racing holds against a shared budget scope atomically', async () => {
    const scopeId = `member:${crypto.randomUUID()}:2026-07`;
    const walletIds = await Promise.all([
      seedWallet(10_000_000_000n),
      seedWallet(10_000_000_000n),
      seedWallet(10_000_000_000n),
    ]);
    const deps = { redis, db, stores };
    const decisions = await Promise.all(
      walletIds.map((walletId) =>
        admitRun(
          deps,
          request(walletId, {
            readScopes: scopesAt(walletId, [
              { kind: 'member', scopeId, remainingNanoUsd: 250_000_000n },
            ]),
          })
        )
      )
    );
    const admitted = decisions.filter((d) => d._unsafeUnwrap().admitted);
    expect(admitted).toHaveLength(2);
    await redis.del(BILLING_KEYS.scopeHolds.buildKey(scopeId));
  });

  it('blocks paid admission on an overdrawn balance', async () => {
    // An overdrawn wallet carries no cushion — the cushion is what lets a
    // positive balance go negative ONCE, not a standing overdraft facility — so
    // there is nothing to cover a further $0.10 estimate.
    const walletId = await seedWallet(-600_000_000n);
    const decision = await decide({ redis, db, stores }, request(walletId));
    expect(decision).toEqual({ admitted: false, reason: 'insufficient-balance' });
  });

  it('bootstraps the snapshot from Postgres on a miss, carrying the wallet type', async () => {
    const walletId = await seedWallet(1_000_000_000n, 7n);
    const decision = await decide({ redis, db, stores }, request(walletId));
    expect(decision.admitted).toBe(true);
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number; type: string }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.balanceNanoUsd).toBe('1000000000');
    expect(stored?.ledgerSeq).toBe(7);
    expect(stored?.type).toBe('purchased');
  });

  it('fails closed with a typed error when Redis is down', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const result = await admitRun({ redis: deadRedis, db, stores }, request(walletId));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it("the hold outlives its run's hard stop", async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const decision = await decide(
      { redis, db, stores },
      request(walletId, { deadlineClass: 'text' })
    );
    if (!decision.admitted) throw new Error('expected an admitted run');
    expect(decision.hold.expiresAtMs).toBeGreaterThanOrEqual(
      NOW.getTime() + runTimeBounds('text').hardStopAfterMs + 60_000
    );
  });

  it('gives a media hold a lifetime of its 20-minute hard stop plus the margin', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const decision = await decide(
      { redis, db, stores },
      request(walletId, { deadlineClass: 'media' })
    );
    if (!decision.admitted) throw new Error('expected an admitted run');
    expect(decision.hold.expiresAtMs).toBe(
      NOW.getTime() + 20 * 60 * 1000 + HOLD_TTL_MARGIN_SECONDS * 1000
    );
  });

  it('ignores expired holds when summing reservations', async () => {
    const walletId = await seedWallet(150_000_000n);
    const deps = { redis, db, stores };
    const first = await decide(deps, request(walletId));
    expect(first.admitted).toBe(true);
    const afterExpiry = new Date(
      NOW.getTime() + runTimeBounds('text').hardStopAfterMs + HOLD_TTL_MARGIN_SECONDS * 1000 + 1
    );
    const second = await decide(deps, request(walletId, { now: afterExpiry }));
    expect(second.admitted).toBe(true);
  });
});

describe('the refusal names which budget scope bound', () => {
  /**
   * All three levels ride ONE request, so the level a refusal names is a claim
   * about the script's index→scope mapping rather than about which level
   * happened to be present. Permuting `LEVELS` proves nothing — `kind` travels
   * with each entry, so every expectation follows it and all three still pass.
   * The mutations these assertions do catch are the ones on the mapping itself:
   * shift the index the Lua reports (`(i - 2)` → `(i - 1)` in
   * `ADMISSION_SCRIPT`) and all three move — the first two name the next level
   * up, the third runs past the end and fails closed; or swap two entries in
   * `BUDGET_REFUSAL_BY_KIND` and those two trade reasons. There is no Lua
   * interpreter in the repo, so this only ever runs against real Redis.
   */
  const LEVELS: readonly BudgetScopeKind[] = ['allowance', 'member', 'conversation'];
  const ESTIMATE = 100_000_000n;
  const GENEROUS = 10_000_000_000n;

  async function refuseOn(bound: BudgetScopeKind): Promise<AdmissionDecision> {
    const walletId = await seedWallet(GENEROUS);
    const unique = crypto.randomUUID();
    const budgets: readonly BudgetScope[] = LEVELS.map((kind) => ({
      kind,
      scopeId: `${kind}:${unique}`,
      remainingNanoUsd: kind === bound ? ESTIMATE - 1n : GENEROUS,
    }));
    return decide(
      { redis, db, stores },
      request(walletId, { readScopes: scopesAt(walletId, budgets), estimateNanoUsd: ESTIMATE })
    );
  }

  it('names the allowance level when the daily allowance bound', async () => {
    expect(await refuseOn('allowance')).toEqual({
      admitted: false,
      reason: 'allowance-exceeded',
    });
  });

  it('names the member level when a member budget bound', async () => {
    expect(await refuseOn('member')).toEqual({
      admitted: false,
      reason: 'member-budget-exceeded',
    });
  });

  it('names the conversation level when a conversation budget bound', async () => {
    expect(await refuseOn('conversation')).toEqual({
      admitted: false,
      reason: 'conversation-budget-exceeded',
    });
  });

  it('fails closed when the script names a scope the request did not carry', async () => {
    const walletId = await seedWallet(GENEROUS);
    const fakeRedis = {
      get: () =>
        Promise.resolve({ balanceNanoUsd: '10000000000', ledgerSeq: 0, type: 'purchased' }),
      createScript: () => ({ exec: () => Promise.resolve('budget-exceeded:7') }),
    } as unknown as typeof redis;
    const result = await admitRun({ redis: fakeRedis, db, stores }, request(walletId));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('free-tier admission (allowance as budget, balance check derived from wallet type)', () => {
  it('admits a zero-balance free wallet against its allowance scope', async () => {
    const walletId = await seedWallet(0n, 0n, 'free');
    const scopeId = `allowance:${walletId}:2026-07-03`;
    const decision = await decide(
      { redis, db, stores },
      request(walletId, {
        readScopes: scopesAt(walletId, [
          { kind: 'allowance', scopeId, remainingNanoUsd: 150_000_000n },
        ]),
      })
    );
    expect(decision.admitted).toBe(true);
    await redis.del(BILLING_KEYS.scopeHolds.buildKey(scopeId));
  });

  it('fails closed to the balance check when a cached snapshot carries no wallet type', async () => {
    const walletId = await seedWallet(0n, 0n, 'free');
    await redis.set(
      BILLING_KEYS.walletSnapshot.buildKey(walletId),
      JSON.stringify({ balanceNanoUsd: '0', ledgerSeq: 0 })
    );
    const scopeId = `allowance:${walletId}:2026-07-03`;
    const decision = await decide(
      { redis, db, stores },
      request(walletId, {
        readScopes: scopesAt(walletId, [
          { kind: 'allowance', scopeId, remainingNanoUsd: 150_000_000n },
        ]),
      })
    );
    expect(decision).toEqual({ admitted: false, reason: 'insufficient-balance' });
    await redis.del(BILLING_KEYS.scopeHolds.buildKey(scopeId));
  });
});

describe('admitRun honors spendableFundsNanoUsd (paid negative-balance cushion)', () => {
  const BALANCE = 100_000_000_000n; // a freshly funded $100 wallet
  // The one spendable function the estimate side ALSO sizes against — no second
  // representation of `balance + cushion` in this test.
  const SPENDABLE = spendableFundsNanoUsd(BALANCE);

  it('admits a paid turn whose estimate exceeds the raw balance but fits within spendable funds', async () => {
    const walletId = await seedWallet(BALANCE);
    const estimateNanoUsd = SPENDABLE - 1n; // over balance, within the cushion (~$100.4999)
    const decision = await decide({ redis, db, stores }, request(walletId, { estimateNanoUsd }));
    expect(decision.admitted).toBe(true);
  });

  it('still refuses a paid turn whose estimate exceeds spendable funds', async () => {
    const walletId = await seedWallet(BALANCE);
    const estimateNanoUsd = SPENDABLE + 1n;
    const decision = await decide({ redis, db, stores }, request(walletId, { estimateNanoUsd }));
    expect(decision).toEqual({ admitted: false, reason: 'insufficient-balance' });
  });

  it('admits a turn sized to exactly the spendable funds on exactly the balance (admission↔estimate share one rule)', async () => {
    const walletId = await seedWallet(BALANCE);
    const estimateNanoUsd = SPENDABLE; // spendableFundsNanoUsd(remaining) is the estimate ceiling
    const decision = await decide({ redis, db, stores }, request(walletId, { estimateNanoUsd }));
    expect(decision.admitted).toBe(true);
  });

  it('PAID_CUSHION_NANO_USD is the exact gap between spendable and raw balance', () => {
    expect(SPENDABLE - BALANCE).toBe(PAID_CUSHION_NANO_USD);
  });

  it('withholds the cushion from a purchased wallet spent to exactly zero', async () => {
    // The cushion is keyed on the BALANCE, never on the wallet's type: at zero the
    // wallet holds free-tier money and carries none, so an estimate well inside the
    // cushion is refused where a type-keyed derivation would have admitted it on
    // overdraft room this wallet does not have. This is the discriminating case for
    // that keying — the overdrawn-balance case refuses under either derivation.
    // Reachable rather than hypothetical: a sibling run may settle the wallet to
    // zero between the payer freeze, which reads Postgres, and this admission,
    // which reads the Redis snapshot.
    const walletId = await seedWallet(0n);
    const estimateNanoUsd = PAID_CUSHION_NANO_USD / 5n; // inside the cushion by construction
    const decision = await decide({ redis, db, stores }, request(walletId, { estimateNanoUsd }));
    expect(decision).toEqual({ admitted: false, reason: 'insufficient-balance' });
  });
});

describe('admitRun input and defect handling', () => {
  it('returns not_found for a wallet that does not exist', async () => {
    const result = await admitRun({ redis, db, stores }, request(crypto.randomUUID()));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('rejects a non-positive estimate as a caller bug', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    expect(() =>
      admitRun({ redis, db, stores }, request(walletId, { estimateNanoUsd: 0n }))
    ).toThrow(/estimate must be positive/);
  });

  it('sets the holds-hash lifetime to 21 minutes', () => {
    expect(MAX_HOLD_TTL_SECONDS).toBe(21 * 60);
  });

  it.each(DEADLINE_CLASSES)(
    'fits a %s hold inside the holds-hash lifetime',
    async (deadlineClass) => {
      const walletId = await seedWallet(1_000_000_000n);
      const decision = await decide({ redis, db, stores }, request(walletId, { deadlineClass }));
      if (!decision.admitted) throw new Error('expected an admitted run');
      expect(decision.hold.expiresAtMs).toBeLessThanOrEqual(
        NOW.getTime() + MAX_HOLD_TTL_SECONDS * 1000
      );
    }
  );

  it('surfaces an unknown script outcome as unavailable', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const fakeRedis = {
      // A present snapshot lets the flow reach the holds script.
      get: () => Promise.resolve({ balanceNanoUsd: '1000000000', ledgerSeq: 0, type: 'purchased' }),
      createScript: () => ({ exec: () => Promise.resolve('garbage') }),
    } as unknown as typeof redis;
    const result = await admitRun({ redis: fakeRedis, db, stores }, request(walletId));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails closed when the snapshot read is unavailable', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const fakeRedis = {
      get: () => Promise.reject(new Error('redis down')),
    } as unknown as typeof redis;
    const result = await admitRun({ redis: fakeRedis, db, stores }, request(walletId));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('admission checks the snapshot sequence it priced from', () => {
  const BALANCE = 1_000_000_000n;
  const CHARGE = 800_000_000n;
  /** Within what the pre-charge balance funds, beyond what the charged one does. */
  const ESTIMATE = spendableFundsNanoUsd(BALANCE - CHARGE) + 1n;

  it('re-reads when a settlement lands between the snapshot read and the script', async () => {
    const walletId = await seedWallet(BALANCE);
    await snapshotWritten(walletId, BALANCE, 0n);
    const scopeRead = scopeReadAfter(walletId, (read) =>
      read === 1 ? settleCharge(walletId, CHARGE) : Promise.resolve()
    );
    const decision = await decide(
      { redis, db, stores },
      request(walletId, { estimateNanoUsd: ESTIMATE, readScopes: scopeRead.readScopes })
    );
    expect(decision).toEqual({ admitted: false, reason: 'insufficient-balance' });
    expect(scopeRead.reads()).toBe(2);
  });

  it('fails closed as unavailable when the snapshot moves again before the second script', async () => {
    const walletId = await seedWallet(BALANCE);
    await snapshotWritten(walletId, BALANCE, 0n);
    const scopeRead = scopeReadAfter(walletId, () => settleCharge(walletId, 1n));
    const result = await admitRun(
      { redis, db, stores },
      request(walletId, { estimateNanoUsd: 1n, readScopes: scopeRead.readScopes })
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(scopeRead.reads()).toBe(2);
  });

  it('refuses to price against scope rows read before the snapshot sequence', async () => {
    const walletId = await seedWallet(BALANCE, 5n);
    await snapshotWritten(walletId, BALANCE, 5n);
    const olderScopeRead: AdmissionRequest['readScopes'] = () =>
      okAsync({ scopes: [], walletSeq: 4n });
    const result = await admitRun(
      { redis, db, stores },
      request(walletId, { estimateNanoUsd: 1n, readScopes: olderScopeRead })
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('re-reads when the snapshot expired between the read and the script', async () => {
    const walletId = await seedWallet(BALANCE);
    await snapshotWritten(walletId, BALANCE, 0n);
    const scopeRead = scopeReadAfter(walletId, async (read) => {
      if (read === 1) await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
    });
    const decision = await decide(
      { redis, db, stores },
      request(walletId, { estimateNanoUsd: 1n, readScopes: scopeRead.readScopes })
    );
    expect(decision.admitted).toBe(true);
    expect(scopeRead.reads()).toBe(2);
  });
});

describe('releaseHold', () => {
  it('writes the committed balance through, so the next admission prices the settled charge', async () => {
    const balance = 1_000_000_000n;
    const charge = 800_000_000n;
    const walletId = await seedWallet(balance);
    const deps = { redis, db, stores };
    const first = request(walletId);
    const admitted = await decide(deps, first);
    expect(admitted.admitted).toBe(true);
    await commitCharge(walletId, charge);
    const released = await releaseHold(deps, { walletId, holdId: first.holdId, scopeIds: [] });
    released._unsafeUnwrap();
    // Within what the pre-charge balance funds, beyond what the charged one does.
    const estimateNanoUsd = spendableFundsNanoUsd(balance - charge) + 1n;
    expect(estimateNanoUsd).toBeLessThanOrEqual(spendableFundsNanoUsd(balance));
    const second = await decide(deps, request(walletId, { estimateNanoUsd }));
    expect(second).toEqual({ admitted: false, reason: 'insufficient-balance' });
  });

  it('leaves the hold in place when the wallet read fails', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const req = request(walletId);
    const admitted = await decide({ redis, db, stores }, req);
    expect(admitted.admitted).toBe(true);
    const failingStores = {
      ...stores,
      readWalletSnapshot: () => errAsync(unavailableError('wallet read failed')),
    };
    const released = await releaseHold(
      { redis, db, stores: failingStores },
      { walletId, holdId: req.holdId, scopeIds: [] }
    );
    expect(released.isErr()).toBe(true);
    expect(await holdPresent(BILLING_KEYS.walletHolds.buildKey(walletId), req.holdId)).toBe(true);
  });

  it('leaves the hold in place when the wallet has no row', async () => {
    const walletId = crypto.randomUUID();
    const holdsKey = BILLING_KEYS.walletHolds.buildKey(walletId);
    const holdId = crypto.randomUUID();
    await redis.hset(holdsKey, { [holdId]: `1:${String(NOW.getTime() + HOUR_MS)}` });
    const released = await releaseHold({ redis, db, stores }, { walletId, holdId, scopeIds: [] });
    expect(released.isErr()).toBe(true);
    expect(await holdPresent(holdsKey, holdId)).toBe(true);
    await redis.del(holdsKey);
  });

  it('keeps a stored snapshot newer than the committed one', async () => {
    const walletId = await seedWallet(700_000_000n, 3n);
    await snapshotWritten(walletId, 500_000_000n, 9n);
    const released = await releaseHold(
      { redis, db, stores },
      { walletId, holdId: crypto.randomUUID(), scopeIds: [] }
    );
    released._unsafeUnwrap();
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored).toMatchObject({ balanceNanoUsd: '500000000', ledgerSeq: 9 });
  });

  it('removes the hold from every scope hash it was placed in', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const scopeId = `member:${crypto.randomUUID()}`;
    const scope = { kind: 'member' as const, scopeId, remainingNanoUsd: 1_000_000_000n };
    const req = request(walletId, { readScopes: scopesAt(walletId, [scope]) });
    const admitted = await decide({ redis, db, stores }, req);
    expect(admitted.admitted).toBe(true);
    const released = await releaseHold(
      { redis, db, stores },
      { walletId, holdId: req.holdId, scopeIds: [scopeId] }
    );
    released._unsafeUnwrap();
    expect(await holdPresent(BILLING_KEYS.scopeHolds.buildKey(scopeId), req.holdId)).toBe(false);
    expect(await holdPresent(BILLING_KEYS.walletHolds.buildKey(walletId), req.holdId)).toBe(false);
  });

  it('frees the reserved capacity for the next run', async () => {
    const walletId = await seedWallet(150_000_000n);
    const deps = { redis, db, stores };
    const req = request(walletId);
    const first = await decide(deps, req);
    expect(first.admitted).toBe(true);
    const released = await releaseHold(deps, {
      walletId,
      holdId: req.holdId,
      scopeIds: [`member:${walletId}:2026-07`],
    });
    released._unsafeUnwrap();
    const second = await decide(deps, request(walletId));
    expect(second.admitted).toBe(true);
  });
});

describe('writeThroughSnapshot', () => {
  it('writes a newer snapshot and reports it', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    const written = await snapshotWritten(walletId, 900_000_000n, 1n);
    expect(written).toBe(true);
  });

  it('CASes on the ledger sequence — an older write can never regress the snapshot', async () => {
    const walletId = await seedWallet(1_000_000_000n);
    await snapshotWritten(walletId, 800_000_000n, 5n);
    const stale = await snapshotWritten(walletId, 999_000_000n, 4n);
    expect(stale).toBe(false);
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.balanceNanoUsd).toBe('800000000');
    expect(stored?.ledgerSeq).toBe(5);
  });
});

describe('refreshWalletSnapshot (Postgres-truth write-through)', () => {
  it('reads the committed wallet and writes the snapshot through', async () => {
    const walletId = await seedWallet(700_000_000n, 3n);
    // A stale cached snapshot from admission time must be superseded.
    await snapshotWritten(walletId, 1_000_000_000n, 2n);
    const refreshed = await refreshWalletSnapshot({ redis, db, stores }, walletId);
    refreshed._unsafeUnwrap();
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number; type: string }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.balanceNanoUsd).toBe('700000000');
    expect(stored?.ledgerSeq).toBe(3);
    expect(stored?.type).toBe('purchased');
  });

  it('never regresses a newer snapshot (CAS on the ledger sequence)', async () => {
    const walletId = await seedWallet(700_000_000n, 3n);
    await snapshotWritten(walletId, 500_000_000n, 9n);
    const refreshed = await refreshWalletSnapshot({ redis, db, stores }, walletId);
    refreshed._unsafeUnwrap();
    const stored = await redis.get<{ balanceNanoUsd: string; ledgerSeq: number }>(
      BILLING_KEYS.walletSnapshot.buildKey(walletId)
    );
    expect(stored?.ledgerSeq).toBe(9);
  });

  it('fails with not_found for a wallet that does not exist', async () => {
    const result = await refreshWalletSnapshot(
      { redis, db, stores },
      '00000000-0000-0000-0000-000000000001'
    );
    expect(result.isErr()).toBe(true);
  });
});
