/**
 * Double entry, over every settlement the charge composer admits: whatever a
 * settlement charges, the legs it writes sum to zero — within each
 * transaction id and across the settlement. Generation is what puts amounts at
 * both ends of the 63-bit range the ledger column holds, zero and the widest,
 * which is where a zero-sum invariant is thinnest.
 *
 * The world here is in memory. The property is about what the composer writes
 * into a transaction, so the transaction's own rollback is not modeled.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MODALITIES } from '@hushbox/shared';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { chargeWithinTx } from './charge.js';
import type { ChargeInput, ChargeSender } from './charge.js';
import type { Database } from '@hushbox/db';
import type { CompletionTokens, MediaGenerationFacts } from '@hushbox/shared';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type {
  BillingStores,
  LedgerLegInput,
  UsageRecordInput,
  WalletRecord,
  WalletType,
} from '../ports/index.js';

/**
 * The widest amount one half of a charge may carry. The ledger's amount column
 * is a 64-bit signed integer, so capping each half at half its range keeps
 * every charge the generator builds a charge the ledger can hold.
 */
const HALF_CHARGE_MAX = (2n ** 63n - 1n) / 2n;

/** The two wallets a generated settlement charges against. */
const WALLET_IDS = ['wallet-a', 'wallet-b'] as const;

/**
 * A pool small enough that a settlement repeats a key, which is the replay the
 * composer answers by writing no legs at all.
 */
const CHARGE_KEYS = ['charge-key-0', 'charge-key-1', 'charge-key-2'] as const;

/**
 * The endpoints are drawn deliberately rather than waited for: they carry
 * negligible measure under a uniform draw over a range this wide, and they are
 * the two amounts a zero-sum invariant is thinnest at.
 */
const amountArb = fc.oneof(
  { arbitrary: fc.constantFrom(0n, 1n, HALF_CHARGE_MAX), weight: 1 },
  { arbitrary: fc.bigInt({ min: 0n, max: HALF_CHARGE_MAX }), weight: 2 }
);

const senderArb: fc.Arbitrary<ChargeSender> = fc.oneof(
  fc.constant({ kind: 'user', userId: 'sender-user' } as const),
  fc.constant({ kind: 'linkGuest', linkId: 'sender-link' } as const)
);

const tokensArb: fc.Arbitrary<CompletionTokens> = fc.record({
  inputTokens: fc.nat(4096),
  outputTokens: fc.nat(4096),
  reasoningTokens: fc.nat(4096),
  cachedInputTokens: fc.nat(4096),
});

const mediaArb: fc.Arbitrary<MediaGenerationFacts> = fc.record({
  imageCount: fc.nat(4),
  durationMs: fc.nat(60_000),
});

const drawnChargeArb = fc.record({
  walletId: fc.constantFrom(...WALLET_IDS),
  idempotencyKey: fc.constantFrom(...CHARGE_KEYS),
  billableCostNanoUsd: amountArb,
  storageFeeNanoUsd: amountArb,
  modality: fc.constantFrom(...MODALITIES),
  sender: senderArb,
  isEstimated: fc.boolean(),
  tokens: fc.option(tokensArb, { nil: undefined }),
  media: fc.option(mediaArb, { nil: undefined }),
  memberBudget: fc.option(
    fc.record({ memberId: fc.constant('member-a'), budgetNanoUsd: amountArb }),
    { nil: undefined }
  ),
  conversationId: fc.option(fc.constantFrom('conversation-a', 'conversation-b'), {
    nil: undefined,
  }),
});

type DrawnCharge = typeof drawnChargeArb extends fc.Arbitrary<infer T> ? T : never;

const settlementArb = fc.record({
  walletTypes: fc.tuple(
    fc.constantFrom<WalletType>('purchased', 'free'),
    fc.constantFrom<WalletType>('purchased', 'free')
  ),
  charges: fc.array(drawnChargeArb, { maxLength: 6 }),
});

type DrawnSettlement = typeof settlementArb extends fc.Arbitrary<infer T> ? T : never;

interface WalletState {
  type: WalletType;
  balanceNanoUsd: bigint;
  ledgerSeq: bigint;
}

/** Everything the composer writes, and the rows it reads back. */
interface World {
  readonly wallets: Map<string, WalletState>;
  readonly usageIdByKey: Map<string, string>;
  readonly legs: LedgerLegInput[];
}

function makeWorld(walletTypes: readonly [WalletType, WalletType]): World {
  const [first, second] = walletTypes;
  const [firstId, secondId] = WALLET_IDS;
  return {
    wallets: new Map([
      [firstId, { type: first, balanceNanoUsd: 0n, ledgerSeq: 0n }],
      [secondId, { type: second, balanceNanoUsd: 0n, ledgerSeq: 0n }],
    ]),
    usageIdByKey: new Map(),
    legs: [],
  };
}

function walletOf(world: World, walletId: string): WalletState {
  const wallet = world.wallets.get(walletId);
  // The composer only ever locks a wallet its caller resolved; a miss here
  // would be this world disagreeing with its own generator.
  if (wallet === undefined) throw new Error('settlement charged an absent wallet');
  return wallet;
}

function makeStores(world: World): BillingStores {
  const reached: Pick<
    BillingStores,
    | 'lockWalletWithinTx'
    | 'insertUsageRecordIfAbsentWithinTx'
    | 'insertLlmCompletionWithinTx'
    | 'insertMediaGenerationWithinTx'
    | 'insertLedgerLegsWithinTx'
    | 'updateWalletBalanceWithinTx'
    | 'addSpendingWithinTx'
  > = {
    lockWalletWithinTx: (_tx: SettlementTx, walletId: string): Promise<WalletRecord> =>
      Promise.resolve({ id: walletId, ...walletOf(world, walletId) }),
    insertUsageRecordIfAbsentWithinTx: (
      _tx: SettlementTx,
      input: UsageRecordInput
    ): Promise<{ readonly id: string; readonly created: boolean }> => {
      const existing = world.usageIdByKey.get(input.idempotencyKey);
      if (existing !== undefined) return Promise.resolve({ id: existing, created: false });
      const id = `usage-${String(world.usageIdByKey.size)}`;
      world.usageIdByKey.set(input.idempotencyKey, id);
      return Promise.resolve({ id, created: true });
    },
    insertLlmCompletionWithinTx: (): Promise<void> => Promise.resolve(),
    insertMediaGenerationWithinTx: (): Promise<void> => Promise.resolve(),
    insertLedgerLegsWithinTx: (
      _tx: SettlementTx,
      legs: readonly LedgerLegInput[]
    ): Promise<void> => {
      world.legs.push(...legs);
      return Promise.resolve();
    },
    updateWalletBalanceWithinTx: (
      _tx: SettlementTx,
      walletId: string,
      balanceNanoUsd: bigint,
      ledgerSeq: bigint
    ): Promise<void> => {
      const wallet = walletOf(world, walletId);
      wallet.balanceNanoUsd = balanceNanoUsd;
      wallet.ledgerSeq = ledgerSeq;
      return Promise.resolve();
    },
    addSpendingWithinTx: (): Promise<void> => Promise.resolve(),
  };
  // The `Pick` is the check: a member the port does not declare, or one whose
  // signature is unrelated to the port's, fails to compile. The assertion only
  // widens that to the full port, whose remaining members are absent here and
  // would be undefined if the composer reached for one.
  return reached as BillingStores;
}

/**
 * A transaction opener over the in-memory world. The settlement entry point is
 * what brands the handle, so the composer receives the same capability it does
 * in production and this file forges nothing.
 */
function makeDb(): Database {
  return {
    transaction: (body: (tx: object) => Promise<unknown>): Promise<unknown> => body({}),
  } as unknown as Database;
}

function chargeInputFrom(drawn: DrawnCharge): ChargeInput {
  return {
    walletId: drawn.walletId,
    payerUserId: 'payer-user',
    sender: drawn.sender,
    runId: 'run',
    contentItemId: 'content-item',
    modelId: 'vendor/model',
    providerName: 'vendor',
    modality: drawn.modality,
    billableCostNanoUsd: drawn.billableCostNanoUsd,
    storageFeeNanoUsd: drawn.storageFeeNanoUsd,
    isEstimated: drawn.isEstimated,
    idempotencyKey: drawn.idempotencyKey,
    now: new Date(TEST_DAY_START),
    ...(drawn.tokens === undefined ? {} : { tokens: drawn.tokens }),
    ...(drawn.media === undefined ? {} : { media: drawn.media }),
    ...(drawn.memberBudget === undefined ? {} : { memberBudget: drawn.memberBudget }),
    ...(drawn.conversationId === undefined ? {} : { conversationId: drawn.conversationId }),
  };
}

async function settle(drawn: DrawnSettlement): Promise<World> {
  const world = makeWorld(drawn.walletTypes);
  const stores = makeStores(world);
  await runSettlement(makeDb(), async (tx: SettlementTx) => {
    for (const charge of drawn.charges) {
      await chargeWithinTx(stores, tx, chargeInputFrom(charge));
    }
  });
  return world;
}

function sumsByTransaction(legs: readonly LedgerLegInput[]): readonly bigint[] {
  const totals = new Map<string, bigint>();
  for (const leg of legs) {
    totals.set(leg.transactionId, (totals.get(leg.transactionId) ?? 0n) + leg.amountNanoUsd);
  }
  return [...totals.values()];
}

describe('the settlement charge composer', () => {
  it('writes legs that sum to zero, per transaction and over the settlement', async () => {
    await fc.assert(
      fc.asyncProperty(settlementArb, async (drawn) => {
        const world = await settle(drawn);
        for (const sum of sumsByTransaction(world.legs)) {
          expect(sum).toBe(0n);
        }
        expect(world.legs.reduce((total, leg) => total + leg.amountNanoUsd, 0n)).toBe(0n);
      })
    );
  });
});
