import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import {
  DB_CONNECT_TIMEOUT_MS,
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  ledgerEntries,
  memberBudgets,
  messages,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ERROR_CODES, PAID_CUSHION_NANO_USD, applyMarkup } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import {
  admitRun,
  chargeWithinTx,
  createBillingStores,
  releaseHold,
  resolveBudgetScopes,
} from '../../../billing/index.js';
import { createConversationsStores } from '../../../conversations/index.js';
import { createEstimateRun, snapshotResolver } from '../../../models/index.js';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { CHAT_TURN_HOOKS, PER_WALLET_CONCURRENT_RUN_CAP } from '../constants.js';
import { compileSingleTurn } from './definition.js';
import { resolveTurnContext } from './context.js';
import { turnMinCost } from './pricing.js';
import {
  seatCurrentEpochHolder,
  seedConversationWithEpoch,
} from '../../../../test-support/conversation-seed.js';
import { holdTableLock } from '../../../../test-support/hold-table-lock.js';
import type { TurnContext } from './context.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { NanoUSD } from '@hushbox/shared';

/** The run estimator read as its hold's total. */
function createEstimateTotal(
  resolveModel: Parameters<typeof createEstimateRun>[0]
): (definition: WorkflowDefinition) => Result<NanoUSD, DomainError> {
  const reserve = createEstimateRun(resolveModel);
  return (definition) => reserve(definition).map((reservation) => reservation.totalNanoUsd);
}

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/**
 * The payer the turn freezes is the one the billed row records. This exercises
 * the whole producer→row path against real rows — `resolveTurnContext` picks the
 * wallet, `chargeWithinTx` writes the usage record — because the two halves are
 * only correct together: a payer column that disagrees with the charged wallet's
 * owner cannot be aggregated by anyone.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat turn-context integration tests');
}

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const billing = createBillingStores();
const BYTES = new Uint8Array([9, 9, 9]);
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@turn-context.test`,
        username: `tc${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const id = first(rows, 'user').id;
  createdUserIds.push(id);
  return id;
}

async function seedWallets(userId: string, purchasedBalanceNanoUsd: bigint): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: purchasedBalanceNanoUsd })
    .returning({ id: wallets.id });
  await db.insert(wallets).values({ userId, type: 'free', balanceNanoUsd: 0n });
  return first(rows, 'wallet').id;
}

interface GroupFixture {
  readonly ownerUserId: string;
  readonly ownerWalletId: string;
  readonly memberUserId: string;
  readonly memberId: string;
  readonly conversationId: string;
  readonly conversationBudgetNanoUsd: bigint;
  readonly contentItemId: string;
}

/** The three group dimensions a case wants to move; each defaults to ample. */
interface GroupCaps {
  readonly ownerBalanceNanoUsd?: bigint;
  readonly memberBudgetNanoUsd?: bigint;
  readonly conversationBudgetNanoUsd?: bigint;
}

/**
 * An owner-funded group conversation: the owner holds the funds and sets both
 * caps; the member sends and holds funds of their own, so a payer resolved from
 * the sender rather than the wallet stays syntactically valid — only the wrong
 * person.
 */
async function seedOwnerFundedGroup(caps: GroupCaps = {}): Promise<GroupFixture> {
  const conversationBudgetNanoUsd = caps.conversationBudgetNanoUsd ?? 5_000_000_000n;
  const ownerUserId = await seedUser();
  const ownerWalletId = await seedWallets(ownerUserId, caps.ownerBalanceNanoUsd ?? 10_000_000_000n);
  const memberUserId = await seedUser();
  await seedWallets(memberUserId, 10_000_000_000n);

  const { conversationId } = await seedConversationWithEpoch(db, {
    userId: ownerUserId,
    title: BYTES,
    conversationBudgetNanoUsd,
  });
  createdConversationIds.push(conversationId);
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId: memberUserId, privilege: 'write', visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = first(memberRows, 'member').id;
  await db.insert(memberBudgets).values({
    memberId,
    budgetNanoUsd: caps.memberBudgetNanoUsd ?? 5_000_000_000n,
    spentNanoUsd: 0n,
  });

  const messageRows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'assistant',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const contentRows = await db
    .insert(contentItems)
    .values({
      messageId: first(messageRows, 'message').id,
      contentType: 'text',
      encryptedBlob: BYTES,
    })
    .returning({ id: contentItems.id });

  return {
    ownerUserId,
    ownerWalletId,
    memberUserId,
    memberId,
    conversationId,
    conversationBudgetNanoUsd,
    contentItemId: first(contentRows, 'content item').id,
  };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.userId, createdUserIds));
    await db.delete(usageRecords).where(inArray(usageRecords.payerUserId, createdUserIds));
    const walletIds = walletRows.map((row) => row.id);
    if (walletIds.length > 0) {
      // Legs are deleted whole transactions at a time — the zero-sum trigger
      // rejects a delete that leaves one side of a pair behind.
      const legRows = await db
        .select({ transactionId: ledgerEntries.transactionId })
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.walletId, walletIds));
      const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
      if (transactionIds.length > 0) {
        await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
      }
      await db.delete(wallets).where(inArray(wallets.id, walletIds));
    }
  }
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/**
 * The turn the member sends: resolved through the production seam, not
 * hand-built. Handed no priced row, the selection names a model the snapshot
 * does not carry, so the freeze prices nothing and the group comparison is
 * inapplicable — which keeps the owner funding an ample fixture. A case that
 * wants the comparison to bite hands the row that prices it.
 */
async function memberTurnContext(
  fixture: GroupFixture,
  priced?: ModelDescriptor
): Promise<TurnContext> {
  const resolved = await resolveMemberTurn(fixture, priced);
  return resolved._unsafeUnwrap();
}

/** The member's turn freeze as a `Result`, for a case that expects it to refuse. */
function resolveMemberTurn(
  fixture: GroupFixture,
  priced?: ModelDescriptor
): ReturnType<typeof resolveTurnContext> {
  return resolveTurnContext({ conversations: createConversationsStores, billing }, db, {
    conversationId: fixture.conversationId,
    sender: { kind: 'user', userId: fixture.memberUserId },
    now: NOW,
    exposedCatalog: priced === undefined ? [] : [priced],
    selection: { turnSources: [{ kind: 'model', id: priced?.id ?? MODEL.id }] },
    promptCharacterCount: FREEZE_PROMPT_CHARS,
    inputCharacterCount: FREEZE_PROMPT_CHARS,
  });
}

/** Past the pool's acquisition deadline, so a read queued behind the held one would expire. */
const HOLD_MS = DB_CONNECT_TIMEOUT_MS + 1500;

describe('an owner-funded member turn', () => {
  it(
    'funds from the owner when the owner wallet read is held past the acquisition deadline',
    async () => {
      const fixture = await seedOwnerFundedGroup();
      const requestDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
      try {
        // The owner-wallet read goes first; the member and conversation reads follow it.
        const { released } = await holdTableLock(wallets, HOLD_MS);

        const resolved = await resolveTurnContext(
          { conversations: createConversationsStores, billing },
          requestDb,
          {
            conversationId: fixture.conversationId,
            sender: { kind: 'user', userId: fixture.memberUserId },
            now: NOW,
            exposedCatalog: [],
            selection: { turnSources: [{ kind: 'model', id: MODEL.id }] },
            promptCharacterCount: FREEZE_PROMPT_CHARS,
            inputCharacterCount: FREEZE_PROMPT_CHARS,
          }
        );
        await released;

        expect(resolved.isErr() && resolved.error).toBe(false);
        expect(resolved._unsafeUnwrap().walletId).toBe(fixture.ownerWalletId);
      } finally {
        await requestDb.$client.end();
      }
    },
    HOLD_MS * 3
  );

  it('records the owner as the payer and the member as the sender, each queryable alone', async () => {
    const fixture = await seedOwnerFundedGroup();

    const context = await memberTurnContext(fixture);
    expect(context.walletId).toBe(fixture.ownerWalletId);

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      chargeWithinTx(billing, tx, {
        walletId: context.walletId,
        payerUserId: context.payerUserId,
        sender: { kind: 'user', userId: fixture.memberUserId },
        runId,
        contentItemId: fixture.contentItemId,
        modelId: 'turn-context-test/model',
        providerName: 'turn-context-test-provider',
        modality: 'text',
        billableCostNanoUsd: applyMarkup(1_000_000n),
        storageFeeNanoUsd: 0n,
        isEstimated: false,
        idempotencyKey: `turn-context-test:${runId}`,
        now: NOW,
      })
    );

    // Both sides of the row, read independently: the money side names the owner
    // whose wallet was debited, the activity side the member who sent.
    const payerRows = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(eq(usageRecords.payerUserId, fixture.ownerUserId));
    expect(payerRows).toHaveLength(1);
    const senderRows = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(eq(usageRecords.senderUserId, fixture.memberUserId));
    expect(senderRows).toEqual(payerRows);
  });

  it('records a payer that is the charged wallet owner, so the two can never disagree', async () => {
    const fixture = await seedOwnerFundedGroup();

    const context = await memberTurnContext(fixture);

    const walletRows = await db
      .select({ userId: wallets.userId })
      .from(wallets)
      .where(eq(wallets.id, context.walletId));
    expect(context.payerUserId).toBe(first(walletRows, 'wallet').userId);
  });
});

/** The prompt length the freeze prices and the ceiling is solved against. */
const FREEZE_PROMPT_CHARS = 400;

/**
 * A cheap text model, priced so a one-cent ceiling is reachable. Local rather
 * than catalog-read: this file's subject is the money, and a catalog row would
 * couple it to the shared `model_catalog` contention every other integration
 * suite already fights over.
 */
const MODEL: ModelDescriptor = {
  id: 'vendor/cheap',
  provider: 'vendor',
  version: '1',
  inputs: ['text'],
  outputs: ['text'],
  parameters: {},
  behaviors: [],
  limits: { contextLength: 200_000, maxOutputTokens: 64_000 },
  pricing: tokenPricingFixture({ input: 2n, output: 3n }),
  zdrReachable: true,
  releasedAt: FIXTURE_STAMP_SECONDS,
  fetchedAt: 0,
};

/**
 * The same row priced high enough that a turn on it costs more than a one-cent
 * balance — which is what sends the group comparison to the owner's cushioned
 * funds. The test asserts that premise rather than trusting these rates.
 */
const EXPENSIVE_MODEL: ModelDescriptor = {
  ...MODEL,
  id: 'vendor/expensive',
  pricing: tokenPricingFixture({ input: 40_000n, output: 60_000n }),
};

const resolveModel = snapshotResolver([MODEL]);

/**
 * The turn the frozen context funds, priced by the canonical run estimator —
 * the same declared-ceiling figure the admission hook holds against.
 */
function estimateFor(context: TurnContext): bigint {
  const definition = compileSingleTurn(resolveModel, MODEL.id, {
    budget: {
      promptCharacterCount: FREEZE_PROMPT_CHARS,
      inputCharacterCount: FREEZE_PROMPT_CHARS,
      funding: context.funding,
    },
    hooks: CHAT_TURN_HOOKS,
  })._unsafeUnwrap();
  return createEstimateTotal(resolveModel)(definition)._unsafeUnwrap();
}

/**
 * Admission as the run performs it: the frozen payer wallet, the estimate the
 * compiled turn priced, and the member/conversation budget scopes resolved from
 * the same rows the freeze read.
 */
async function admitMemberTurn(
  fixture: GroupFixture,
  context: TurnContext,
  estimateNanoUsd: bigint
): Promise<{ readonly admitted: boolean; readonly reason?: string }> {
  const resolvedScopes = await resolveBudgetScopes(billing, db, {
    now: NOW,
    memberBudget: { memberId: fixture.memberId },
    conversationBudget: {
      conversationId: fixture.conversationId,
      capNanoUsd: fixture.conversationBudgetNanoUsd,
    },
  });
  const scopes = resolvedScopes._unsafeUnwrap();
  const holdId = crypto.randomUUID();
  const admission = await admitRun(
    { redis, db, stores: billing },
    {
      walletId: context.walletId,
      holdId,
      estimateNanoUsd,
      deadlineClass: 'text',
      concurrentRunCap: PER_WALLET_CONCURRENT_RUN_CAP,
      budgets: scopes,
      now: NOW,
    }
  );
  const decision = admission._unsafeUnwrap();
  // Best-effort teardown so a leftover hold cannot leak into a sibling case.
  const released = await releaseHold(redis, {
    walletId: context.walletId,
    holdId,
    scopeIds: scopes.map((scope) => scope.scopeId),
  });
  released.match(
    () => {},
    () => {}
  );
  return decision;
}

describe('a member with a one-cent allocation against a solvent owner', () => {
  /** One cent. The tightest of the three group dimensions in the case below. */
  const ONE_CENT = 10_000_000n;

  it('is admitted end to end: the turn is sized to the allocation, and admission takes it', async () => {
    // The defect this closes: the freeze compared the turn's minimum against the
    // group headroom, while the ceiling was solved against the payer wallet's
    // spendable funds — which carried the owner's $0.50 cushion. The turn was
    // therefore sized at $0.51 against a 1¢ member scope, and the SAME send was
    // refused at admission every time it was retried.
    const fixture = await seedOwnerFundedGroup({ memberBudgetNanoUsd: ONE_CENT });

    const context = await memberTurnContext(fixture);
    expect(context.walletId).toBe(fixture.ownerWalletId);
    expect(context.funding.spendableNanoUsd).toBe(ONE_CENT);

    const estimate = estimateFor(context);
    expect(estimate).toBeLessThanOrEqual(ONE_CENT);

    const decision = await admitMemberTurn(fixture, context, estimate);
    expect(decision).toEqual({ admitted: true, hold: expect.anything() });
  });

  it("sizes the same turn to the OWNER's cushioned funds when the owner's balance is what binds", async () => {
    // The other half of the ruling: the cushion belongs to the wallet, so an
    // owner with a cent left may overdraw it for a member's turn exactly as for
    // their own — and the ceiling then rides that larger figure, because the
    // owner dimension is the binding one.
    const fixture = await seedOwnerFundedGroup({ ownerBalanceNanoUsd: ONE_CENT });

    // The premise, stated rather than assumed: the priced minimum clears the
    // owner's raw balance, so only the cushion can cover it.
    expect(
      turnMinCost(
        [EXPENSIVE_MODEL],
        { turnSources: [{ kind: 'model', id: EXPENSIVE_MODEL.id }] },
        {
          promptCharacterCount: FREEZE_PROMPT_CHARS,
          inputCharacterCount: FREEZE_PROMPT_CHARS,
        }
      )
    ).toBeGreaterThan(ONE_CENT);

    const context = await memberTurnContext(fixture, EXPENSIVE_MODEL);
    expect(context.walletId).toBe(fixture.ownerWalletId);
    expect(context.funding.spendableNanoUsd).toBe(ONE_CENT + PAID_CUSHION_NANO_USD);

    const decision = await admitMemberTurn(fixture, context, estimateFor(context));
    expect(decision.admitted).toBe(true);
  });
});

describe('a turn against a conversation a member has left', () => {
  it('refuses with ROTATION_PENDING while the departed key still holds the current epoch', async () => {
    const fixture = await seedOwnerFundedGroup();
    await seatCurrentEpochHolder(db, {
      conversationId: fixture.conversationId,
      userId: await seedUser(),
      departed: true,
    });

    const resolved = await resolveMemberTurn(fixture);

    expect(resolved._unsafeUnwrapErr()).toMatchObject({
      code: 'conflict',
      wireCode: ERROR_CODES.ROTATION_PENDING,
    });
  });

  it('freezes the turn when every current-epoch wrap belongs to a live seat', async () => {
    const fixture = await seedOwnerFundedGroup();
    await seatCurrentEpochHolder(db, {
      conversationId: fixture.conversationId,
      userId: await seedUser(),
    });

    const resolved = await resolveMemberTurn(fixture);

    expect(resolved._unsafeUnwrap().walletId).toBe(fixture.ownerWalletId);
  });
});
