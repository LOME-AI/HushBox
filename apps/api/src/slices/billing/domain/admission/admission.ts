import { runTimeBounds, spendableFundsNanoUsd } from '@hushbox/shared';
import { notFoundError, unavailableError } from '../../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../../lib/result/index.js';
import { ADMISSION_SCRIPT, SETTLED_RELEASE_SCRIPT, SNAPSHOT_CAS_SCRIPT } from './scripts.js';
import { COST_CIRCUIT_MULTIPLIER, HOLD_TTL_MARGIN_SECONDS } from '../constants.js';
import { BILLING_KEYS } from '../keys.js';
import type { DeadlineClass } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { BillingStores, WalletType } from '../../ports/index.js';
import type { RedisClient } from '../keys.js';

/**
 * Admission — the ONLY balance gate in the system (settlement charges
 * unguarded; negative balances are legal). The spendable-funds rule
 * (`balance + paid cushion`) is computed once in TypeScript via the shared
 * `spendableFundsNanoUsd`; the atomic Redis Lua then check-and-adds over the
 * racy HOLDS state only: spendable − Σ active holds ≥ estimate, the cumulative
 * member/conversation budget scopes, the per-wallet concurrent-run cap — then
 * the TTL hold. The advisory balance is TS-supplied on purpose (the ledger is
 * truth); the Lua first checks that the snapshot it came from is still the
 * stored one, and admission reads again once when it moved. The hold is not
 * money — it auto-expires.
 *
 * Redis down ⇒ paid admission fails CLOSED with a typed `unavailable` error
 * (the route/engine maps it to ADMISSION_UNAVAILABLE). There is no degraded
 * mode: without holds, unguarded settlement would mean unbounded negative
 * exposure.
 */

/**
 * The closed set of budget ceiling levels, and the ONE vocabulary for them.
 * Every consumer that needs to know which ceiling it is holding reads this;
 * deriving the level from a `scopeId` prefix is a string contract where a type
 * belongs, and it is what let the bound scope's identity vanish at the Redis
 * boundary in the first place.
 */
export type BudgetScopeKind = 'allowance' | 'member' | 'conversation';

/** A cumulative budget the run must fit, read from the durable owner-set rows. */
export interface BudgetScope {
  /** Which ceiling this is — the only supported way to read the level. */
  readonly kind: BudgetScopeKind;
  /**
   * The scope's Redis holds-hash key (e.g. `member:<memberId>` or
   * `conversation:<conversationId>`) — cumulative, no period/month suffix and
   * no rollover.
   */
  readonly scopeId: string;
  /** Owner-set cap minus the row's cumulative spent — computed by the caller from Postgres. */
  readonly remainingNanoUsd: bigint;
}

export interface AdmissionRequest {
  readonly walletId: string;
  /**
   * The run's id — one hold per run, released once the run ends, whatever its
   * outcome, or once its expiry passes (the lazy prune or the hash key's TTL).
   */
  readonly holdId: string;
  /**
   * Priced at the declared ceiling: max width × iterations, each tool-carrying
   * node over every step of its loop.
   */
  readonly estimateNanoUsd: bigint;
  /** The run's class: the hold lives until the class's hard stop plus the margin. */
  readonly deadlineClass: DeadlineClass;
  readonly concurrentRunCap: number;
  /**
   * Reads the payer wallet's `ledgerSeq`, then the budget scope rows. Every
   * charge advances that sequence in the same transaction as its scope spends,
   * so every charge at or below the returned sequence is in the returned rows.
   */
  readonly readScopes: () => ResultAsync<
    { readonly scopes: readonly BudgetScope[]; readonly walletSeq: bigint },
    DomainError
  >;
  readonly now: Date;
}

/**
 * Why admission refused, one member per condition the caller can act on. Each
 * budget level is its own reason because the remedy points at a different
 * person: the sender tops up or waits a day for their own allowance, while only
 * the conversation owner can widen a member or conversation ceiling.
 */
export type AdmissionRefusalReason =
  | 'insufficient-balance'
  | 'run-cap'
  | 'allowance-exceeded'
  | 'member-budget-exceeded'
  | 'conversation-budget-exceeded';

/** Compile-exhaustive: a new scope level cannot ship without its own reason. */
const BUDGET_REFUSAL_BY_KIND: Readonly<Record<BudgetScopeKind, AdmissionRefusalReason>> = {
  allowance: 'allowance-exceeded',
  member: 'member-budget-exceeded',
  conversation: 'conversation-budget-exceeded',
};

/** The script's budget refusal, followed by the refused scope's array index. */
const BUDGET_REFUSAL_PREFIX = 'budget-exceeded:';

/**
 * What the workflow engine's cost circuit consumes: the admitted estimate
 * and the named multiplier K — the run is refused new spend once its observed
 * spend exceeds `hold × K` (limit precomputed here).
 */
export interface HoldReadout {
  readonly holdId: string;
  readonly walletId: string;
  readonly scopeIds: readonly string[];
  readonly estimateNanoUsd: bigint;
  readonly costCircuitMultiplier: bigint;
  readonly costCircuitLimitNanoUsd: bigint;
  readonly expiresAtMs: number;
}

export type AdmissionDecision =
  | { readonly admitted: true; readonly hold: HoldReadout }
  | { readonly admitted: false; readonly reason: AdmissionRefusalReason };

export interface AdmissionDeps {
  readonly redis: RedisClient;
  readonly db: Database;
  readonly stores: BillingStores;
}

function redisFailure(cause: unknown): DomainError {
  return unavailableError('admission refused: Redis unavailable (fail-closed)', cause);
}

/**
 * The balance side of admission, computed in TypeScript from the (advisory)
 * snapshot so the spendable rule lives in exactly one place.
 */
interface SpendableDecision {
  /** Free wallets skip the balance gate (allowance rides a budget scope). */
  readonly applyBalanceCheck: boolean;
  /** What the wallet may spend, from the one shared spendable function. */
  readonly effectiveSpendableNanoUsd: bigint;
}

/**
 * Map a snapshot balance + wallet type to the balance decision. A purchased
 * wallet's spendable funds come from the ONE shared function — no tier is derived
 * here, because a wallet-type-keyed derivation and a balance-keyed one priced the
 * same wallet $0.50 apart. A missing type (stale/partial snapshot) fails closed:
 * the balance is still checked, and at the raw balance with no cushion, so it can
 * only refuse where a cushion would have admitted.
 */
function spendableFor(balanceNanoUsd: bigint, type: WalletType | undefined): SpendableDecision {
  if (type === 'free') {
    return { applyBalanceCheck: false, effectiveSpendableNanoUsd: 0n };
  }
  return {
    applyBalanceCheck: true,
    effectiveSpendableNanoUsd:
      type === 'purchased' ? spendableFundsNanoUsd(balanceNanoUsd) : balanceNanoUsd,
  };
}

interface ResolvedSnapshot {
  readonly balanceNanoUsd: bigint;
  readonly type: WalletType | undefined;
  readonly ledgerSeq: bigint;
}

interface StoredSnapshot {
  readonly balanceNanoUsd: string;
  readonly ledgerSeq: number;
  readonly type?: WalletType;
}

/** Read the advisory Redis snapshot (auto-JSON-parsed); null when absent. */
function readRedisSnapshot(
  redis: RedisClient,
  walletId: string
): ResultAsync<ResolvedSnapshot | null, DomainError> {
  return fromPromise(
    redis.get<StoredSnapshot>(BILLING_KEYS.walletSnapshot.buildKey(walletId)),
    redisFailure
  ).map((raw) =>
    raw === null
      ? null
      : {
          balanceNanoUsd: BigInt(raw.balanceNanoUsd),
          type: raw.type,
          ledgerSeq: BigInt(raw.ledgerSeq),
        }
  );
}

/**
 * Postgres-truth bootstrap on a snapshot miss: read the committed balance,
 * CAS-write it into the Redis snapshot, and return it. Shared by the admission
 * cold path and {@link refreshWalletSnapshot}. When the CAS loses to a newer
 * snapshot, the returned sequence is older than the stored one, and admission's
 * sequence check reads again.
 */
function bootstrapSnapshot(
  deps: AdmissionDeps,
  walletId: string
): ResultAsync<ResolvedSnapshot, DomainError> {
  return deps.stores.readWalletSnapshot(deps.db, walletId).andThen((snapshot) => {
    if (snapshot === null) {
      return errAsync(notFoundError('admission: wallet does not exist'));
    }
    return writeThroughSnapshot(deps.redis, {
      walletId,
      balanceNanoUsd: snapshot.balanceNanoUsd,
      ledgerSeq: snapshot.ledgerSeq,
      walletType: snapshot.type,
    }).map(
      (): ResolvedSnapshot => ({
        balanceNanoUsd: snapshot.balanceNanoUsd,
        type: snapshot.type,
        ledgerSeq: snapshot.ledgerSeq,
      })
    );
  });
}

/** Advisory Redis snapshot if present, else the Postgres-truth bootstrap. */
function resolveSnapshot(
  deps: AdmissionDeps,
  walletId: string
): ResultAsync<ResolvedSnapshot, DomainError> {
  return readRedisSnapshot(deps.redis, walletId).andThen((snapshot) =>
    snapshot === null ? bootstrapSnapshot(deps, walletId) : okAsync(snapshot)
  );
}

/**
 * DB-truth snapshot write-through for a balance that moved outside a run. A
 * run's release writes the run's charge through itself ({@link releaseHold}).
 */
export function refreshWalletSnapshot(
  deps: AdmissionDeps,
  walletId: string
): ResultAsync<void, DomainError> {
  return bootstrapSnapshot(deps, walletId).map((): void => undefined);
}

/** What one admission pass priced from: the balance side, its sequence, and the scope read. */
interface AdmissionPricing {
  readonly spendable: SpendableDecision;
  readonly snapshotSeq: bigint;
  readonly walletSeq: bigint;
  readonly scopes: readonly BudgetScope[];
}

function runAdmissionScript(
  deps: AdmissionDeps,
  request: AdmissionRequest,
  ttlSeconds: number,
  pricing: AdmissionPricing
): ResultAsync<string, DomainError> {
  const keys = [
    BILLING_KEYS.walletSnapshot.buildKey(request.walletId),
    BILLING_KEYS.walletHolds.buildKey(request.walletId),
    ...pricing.scopes.map((budget) => BILLING_KEYS.scopeHolds.buildKey(budget.scopeId)),
  ];
  const args = [
    request.holdId,
    request.estimateNanoUsd.toString(10),
    String(request.now.getTime()),
    String(ttlSeconds),
    String(request.concurrentRunCap),
    pricing.spendable.effectiveSpendableNanoUsd.toString(10),
    pricing.spendable.applyBalanceCheck ? '1' : '0',
    pricing.snapshotSeq.toString(10),
    pricing.walletSeq.toString(10),
    ...pricing.scopes.map((budget) => budget.remainingNanoUsd.toString(10)),
  ];
  return fromPromise(
    deps.redis.createScript(ADMISSION_SCRIPT).exec(keys, args) as Promise<string>,
    redisFailure
  );
}

/** The script's answer when the snapshot moved after the balance was read. */
const STALE_OUTCOME = 'stale';

interface PassResult {
  readonly outcome: string;
  readonly scopes: readonly BudgetScope[];
}

/** One admission pass: the snapshot, then the scope read, then the script. */
function admissionPass(
  deps: AdmissionDeps,
  request: AdmissionRequest,
  ttlSeconds: number
): ResultAsync<PassResult, DomainError> {
  return resolvePricedSnapshot(deps, request.walletId).andThen((priced) =>
    request.readScopes().andThen(({ scopes, walletSeq }) =>
      runAdmissionScript(deps, request, ttlSeconds, {
        spendable: priced.spendable,
        snapshotSeq: priced.ledgerSeq,
        walletSeq,
        scopes,
      }).map((outcome): PassResult => ({ outcome, scopes }))
    )
  );
}

/** Estimates are positive by construction; a non-positive one is a caller bug. */
function assertAdmissible(request: AdmissionRequest): void {
  if (request.estimateNanoUsd <= 0n) {
    throw new RangeError('admitRun: estimate must be positive');
  }
}

export function admitRun(
  deps: AdmissionDeps,
  request: AdmissionRequest
): ResultAsync<AdmissionDecision, DomainError> {
  assertAdmissible(request);
  const ttlSeconds =
    runTimeBounds(request.deadlineClass).hardStopAfterMs / 1000 + HOLD_TTL_MARGIN_SECONDS;
  const decide = (
    outcome: string,
    budgets: readonly BudgetScope[]
  ): ResultAsync<AdmissionDecision, DomainError> => {
    if (outcome === 'admitted') {
      return okAsync({
        admitted: true,
        hold: {
          holdId: request.holdId,
          walletId: request.walletId,
          scopeIds: budgets.map((budget) => budget.scopeId),
          estimateNanoUsd: request.estimateNanoUsd,
          costCircuitMultiplier: COST_CIRCUIT_MULTIPLIER,
          costCircuitLimitNanoUsd: request.estimateNanoUsd * COST_CIRCUIT_MULTIPLIER,
          expiresAtMs: request.now.getTime() + ttlSeconds * 1000,
        },
      });
    }
    if (outcome === 'insufficient-balance' || outcome === 'run-cap') {
      return okAsync({ admitted: false, reason: outcome });
    }
    if (outcome.startsWith(BUDGET_REFUSAL_PREFIX)) {
      const bound = budgets[Number(outcome.slice(BUDGET_REFUSAL_PREFIX.length))];
      if (bound === undefined) {
        return errAsync(
          unavailableError('admission script named a budget scope the request did not carry')
        );
      }
      return okAsync({ admitted: false, reason: BUDGET_REFUSAL_BY_KIND[bound.kind] });
    }
    return errAsync(unavailableError('admission script returned an unknown outcome'));
  };
  // A snapshot that moved under the first pass is read again once; one that
  // moves under the second as well fails closed rather than pricing at all.
  return admissionPass(deps, request, ttlSeconds)
    .andThen((first) =>
      first.outcome === STALE_OUTCOME ? admissionPass(deps, request, ttlSeconds) : okAsync(first)
    )
    .andThen(({ outcome, scopes }) =>
      outcome === STALE_OUTCOME
        ? errAsync(unavailableError('admission refused: the wallet snapshot kept moving'))
        : decide(outcome, scopes)
    );
}

/**
 * The exact balance-side decision admission gates with (snapshot resolve +
 * spendable rule), shared with the served-affordability read so the number the
 * client previews against and the number the admission script compares can
 * never diverge.
 */
export function resolveEffectiveSpendable(
  deps: AdmissionDeps,
  walletId: string
): ResultAsync<SpendableDecision, DomainError> {
  return resolvePricedSnapshot(deps, walletId).map((priced) => priced.spendable);
}

/** The balance-side decision and the snapshot sequence it was priced from. */
function resolvePricedSnapshot(
  deps: AdmissionDeps,
  walletId: string
): ResultAsync<{ readonly spendable: SpendableDecision; readonly ledgerSeq: bigint }, DomainError> {
  return resolveSnapshot(deps, walletId).map((snapshot) => ({
    spendable: spendableFor(snapshot.balanceNanoUsd, snapshot.type),
    ledgerSeq: snapshot.ledgerSeq,
  }));
}

interface ReleaseHoldArgs {
  readonly walletId: string;
  readonly holdId: string;
  readonly scopeIds: readonly string[];
}

/**
 * A run's release, at its terminal: reads the payer wallet's committed snapshot
 * from Postgres, then writes it through and removes the hold in one atomic
 * script ({@link SETTLED_RELEASE_SCRIPT}). A failed read, or a wallet with no
 * row, releases nothing and leaves the hold to its TTL: a release never removes
 * a hold without a snapshot that carries its run's charge.
 */
export function releaseHold(
  deps: AdmissionDeps,
  args: ReleaseHoldArgs
): ResultAsync<void, DomainError> {
  return deps.stores.readWalletSnapshot(deps.db, args.walletId).andThen((wallet) => {
    if (wallet === null) {
      return errAsync(notFoundError('release: wallet does not exist'));
    }
    const keys = [
      BILLING_KEYS.walletSnapshot.buildKey(args.walletId),
      BILLING_KEYS.walletHolds.buildKey(args.walletId),
      ...args.scopeIds.map((scopeId) => BILLING_KEYS.scopeHolds.buildKey(scopeId)),
    ];
    const snapshot = snapshotArgs({
      walletId: args.walletId,
      balanceNanoUsd: wallet.balanceNanoUsd,
      ledgerSeq: wallet.ledgerSeq,
      walletType: wallet.type,
    });
    return fromPromise(
      deps.redis.createScript(SETTLED_RELEASE_SCRIPT).exec(keys, [...snapshot, args.holdId]),
      redisFailure
    ).map((): void => undefined);
  });
}

interface SnapshotWrite {
  readonly walletId: string;
  readonly balanceNanoUsd: bigint;
  readonly ledgerSeq: bigint;
  /**
   * Cached in the snapshot so the admission script can derive the balance
   * check from the wallet row's own type: only `free` wallets skip it.
   */
  readonly walletType: WalletType;
}

/**
 * Post-commit snapshot write-through, CASed on the wallet's ledger sequence.
 * Returns whether this write landed (false = a newer snapshot already
 * exists). Callers treat failures as best-effort: the snapshot TTL bounds
 * staleness and a miss re-reads Postgres.
 */
export function writeThroughSnapshot(
  redis: RedisClient,
  write: SnapshotWrite
): ResultAsync<boolean, DomainError> {
  return fromPromise(
    redis
      .createScript(SNAPSHOT_CAS_SCRIPT)
      .exec(
        [BILLING_KEYS.walletSnapshot.buildKey(write.walletId)],
        snapshotArgs(write)
      ) as Promise<number>,
    redisFailure
  ).map((written) => written === 1);
}

/** The snapshot CAS fragment's arguments: the snapshot JSON, its sequence, its TTL. */
function snapshotArgs(write: SnapshotWrite): string[] {
  const payload = JSON.stringify({
    balanceNanoUsd: write.balanceNanoUsd.toString(10),
    ledgerSeq: Number(write.ledgerSeq),
    type: write.walletType,
  });
  return [payload, String(write.ledgerSeq), String(BILLING_KEYS.walletSnapshot.ttlSeconds)];
}
