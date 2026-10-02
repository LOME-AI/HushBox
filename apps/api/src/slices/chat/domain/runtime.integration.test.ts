import { afterAll, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  conversationMembers,
  conversations,
  createDb,
  memberBudgets,
  modelCatalog,
  sharedLinks,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ERROR_CODES, nanoUSD, senderPrincipalId } from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { DAILY_ALLOWANCE_NANO_USD, createBillingStores } from '../../billing/index.js';
import { createConversationsStores } from '../../conversations/index.js';
import { MOCK_ECHO_AFFIXES } from '../../models/index.js';
import { succeedKeyRow } from '../../../lib/idempotency/index.js';
import { createConversationRuntime } from './runtime.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_INPUT, PER_WALLET_CONCURRENT_RUN_CAP } from './constants.js';
import { buildTurnDefinition } from './turn/definition.js';
import { resolveTurnContext } from './turn/context.js';
import { seedConversationWithEpoch } from '../../../test-support/conversation-seed.js';
import { mintLinkCredential } from '../../../test-support/link-credential.js';
import type { TurnContext } from './turn/context.js';
import type { ChatHookBindings, ConversationRuntimeDeps } from './runtime.js';
import type { EpochPublicKeyReader } from './settlement/settlement.js';
import type { ChatStores } from '../ports/stores.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  AdmissionDecision,
  FlowHookBindings,
  FlowRunHandle,
  FlowRunOutcome,
  RunContext,
  RunIdentity,
  SenderPrincipal,
  SettlementRequest,
  WorkflowDefinition,
} from '@hushbox/shared';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for chat runtime integration tests');

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for chat runtime integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([7, 7, 7]);
/** The UTC day the free-tier allowance rows in this file are keyed to. */
const DAY1_KEY = '2026-03-10';
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  // Delete conversations first — the member rows cascade with them, so the
  // user delete never trips the member identity-or-left check via SET NULL.
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  await db.$client.end();
});

function telemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureError: vi.fn(),
  };
}

const readEpochPublicKey: EpochPublicKeyReader = () => Promise.resolve(null);

/** These text-turn runs must never reach storage; a throwing proxy proves it. */
const untouchedStorage = new Proxy(
  {},
  {
    get() {
      throw new Error('storage must not be touched by a text turn');
    },
  }
) as ConversationRuntimeDeps['storage'];

const chatStores: ChatStores = {
  latestMessageIdWithinTx: () => Promise.resolve(null),
  insertMessageWithinTx: () => Promise.resolve(),
  insertContentItemWithinTx: () => Promise.resolve(),
  messageRefWithinTx: () => Promise.resolve(null),
  deleteMessagesByIdWithinTx: () => Promise.resolve(),
  childMessageIdsWithinTx: () => Promise.resolve([]),
  reparentMessagesWithinTx: () => Promise.resolve(),
};

function runtime(): ReturnType<typeof createConversationRuntime> {
  const deps: ConversationRuntimeDeps = {
    db,
    redis,
    telemetry: telemetry(),
    apiKey: 'mock-key',
    searchApiKey: 'mock-key',
    isCI: false,
    chatStores,
    storage: untouchedStorage,
    readEpochPublicKey,
  };
  return createConversationRuntime(deps);
}

/** A runtime with an injected clock — drives the period-keyed allowance day. */
function runtimeWithNow(now: () => Date): ReturnType<typeof createConversationRuntime> {
  return createConversationRuntime({
    db,
    redis,
    telemetry: telemetry(),
    apiKey: 'mock-key',
    searchApiKey: 'mock-key',
    isCI: false,
    chatStores,
    storage: untouchedStorage,
    readEpochPublicKey,
    now,
  });
}

async function seedWallet(balanceNanoUsd: bigint): Promise<{ userId: string }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@chat-rt.test`,
        username: `rt${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd });
  return { userId };
}

/**
 * A registered user with BOTH wallets provisioned (as at registration): a
 * purchased wallet at `purchasedBalanceNanoUsd` and a free wallet at zero. When
 * the purchased balance is ≤ 0 the route selects the free wallet, so this seeds
 * the free-tier payer.
 */
async function seedFreeTierUser(
  purchasedBalanceNanoUsd: bigint
): Promise<{ userId: string; freeWalletId: string }> {
  const { userId } = await seedWallet(purchasedBalanceNanoUsd);
  const freeRows = await db
    .insert(wallets)
    .values({ userId, type: 'free', balanceNanoUsd: 0n })
    .returning({ id: wallets.id });
  const freeWalletId = freeRows[0]?.id;
  if (freeWalletId === undefined) throw new Error('free wallet seed failed');
  return { userId, freeWalletId };
}

/** A user with no wallet — a group sender the owner funds for. */
async function seedBareUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@chat-rt.test`,
        username: `rt${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  return userId;
}

async function ownerWalletId(ownerId: string): Promise<string> {
  const walletRows = await db.select().from(wallets).where(eq(wallets.userId, ownerId));
  const walletId = walletRows[0]?.id;
  if (walletId === undefined) throw new Error('owner wallet seed failed');
  return walletId;
}

/** A conversation owned by `ownerId` with a durable per-conversation cap. */
async function seedConversation(
  ownerId: string,
  conversationBudgetNanoUsd: bigint
): Promise<string> {
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId: ownerId,
    title: BYTES,
    conversationBudgetNanoUsd,
  });
  createdConversationIds.push(conversationId);
  return conversationId;
}

async function addMember(conversationId: string, userId: string): Promise<string> {
  const rows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = rows[0]?.id;
  if (memberId === undefined) throw new Error('member seed failed');
  return memberId;
}

/** A paid RunContext for a turn: `userId` pays, an optional resolved `sender`. */
function paidRunContext(args: {
  readonly userId: string;
  readonly conversationId: string;
  readonly walletId: string;
  /** The resolved sender principal, which the run's scope keys on. */
  readonly sender?: SenderPrincipal;
}): RunContext {
  // Callers that name no sender mean the solo self-funded turn: the payer IS
  // the sender, so the principal is built from the payer rather than omitted.
  const sender: SenderPrincipal = args.sender ?? { kind: 'user', userId: args.userId };
  return {
    mode: 'paid',
    payerUserId: args.userId,
    sender,
    conversationId: args.conversationId,
    walletId: args.walletId,
    epochNumber: 1,
    userMessage: { id: crypto.randomUUID(), content: 'hi' },
    runId: crypto.randomUUID(),
    fence: { id: 'f', executorId: 'e', claims: 1 },
  };
}

/** Seeds a shared link and its active WRITE link-guest member for a conversation. */
async function seedGuestMember(
  conversationId: string
): Promise<{ readonly linkId: string; readonly memberId: string }> {
  const { linkPublicKey, linkAuthHash } = mintLinkCredential();
  const linkRows = await db
    .insert(sharedLinks)
    .values({ conversationId, linkPublicKey, linkAuthHash, displayName: 'Guest' })
    .returning({ id: sharedLinks.id });
  const linkId = linkRows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, linkId, privilege: 'write', visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('guest member seed failed');
  return { linkId, memberId };
}

const CLAIM_USER = crypto.randomUUID();
const IDENTITY: RunIdentity = {
  mode: 'paid',
  payerUserId: CLAIM_USER,
  sender: { kind: 'user', userId: CLAIM_USER },
  conversationId: 'c1',
  walletId: 'w1',
  epochNumber: 1,
  userMessage: { id: crypto.randomUUID(), content: 'hi' },
};

const DEFINITION: WorkflowDefinition = {
  version: 1,
  deadlineClass: 'text',
  hooks: CHAT_TURN_HOOKS,
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition;

describe('conversation runtime — claimRun', () => {
  it('claims a fresh run as the executor with a captured fence', async () => {
    const claim = await runtime().claimRun({
      runKey: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(claim.outcome).toBe('executor');
    if (claim.outcome === 'executor') expect(claim.fence.claims).toBe(1);
  });

  it('attaches a second claim of a live run key', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    await rt.claimRun({ runKey, runId: crypto.randomUUID(), bodyHash: 'h', identity: IDENTITY });
    const again = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(again.outcome).toBe('attach');
  });

  it('surfaces a reused key with a different body as a 409 conflict, never executing', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'body-A',
      identity: IDENTITY,
    });
    expect(first.outcome).toBe('executor');
    const conflict = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'body-B',
      identity: IDENTITY,
    });
    expect(conflict).toEqual({ outcome: 'conflict', code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });

  it('replays a settled run key', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    if (first.outcome !== 'executor') throw new Error('expected executor');
    const flip = await succeedKeyRow(db, first.fence, { ok: true });
    flip._unsafeUnwrap();
    const replay = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(replay).toEqual({ outcome: 'replay', response: { ok: true } });
  });

  /**
   * The payer is re-resolved on every POST of one client-minted key, and it
   * MOVES: a group turn admitted against the owner's headroom resubmits as
   * self-funded once that headroom crosses to ≤ 0, very plausibly because the
   * first attempt's own settlement consumed it. Scoping the key row on the payer
   * would give the resubmit a fresh row. Mid-run the referee would hand it a
   * new executor claim, which the conversation room answers as an attach only
   * through its same-key branch for a run it still streams, leaving that second
   * claim idle until its lease lapses. Post-settle it would re-execute instead
   * of replaying, and that re-execution, under a newly minted user message id,
   * would settle and charge the turn a second time. Both pins below hold the
   * payer's two values against one stable sender.
   *
   * The sender rides the spread — CLAIM_USER on both, never restated — so the
   * ONLY difference between the pair is the payer. SELF_FUNDED names
   * `payerUserId: CLAIM_USER` even though the spread already carries it: the
   * contrast IS the fixture's subject, and a field left to the spread shows a
   * reader no contrast at all.
   */
  const OWNER_FUNDED: RunIdentity = { ...IDENTITY, payerUserId: crypto.randomUUID() };
  const SELF_FUNDED: RunIdentity = { ...IDENTITY, payerUserId: CLAIM_USER };

  it('moves the payer between the two funding shapes while the sender stays fixed', () => {
    expect(OWNER_FUNDED.payerUserId).not.toBe(SELF_FUNDED.payerUserId);
    expect(senderPrincipalId(OWNER_FUNDED.sender)).toBe(senderPrincipalId(SELF_FUNDED.sender));
    expect(senderPrincipalId(SELF_FUNDED.sender)).toBe(CLAIM_USER);
  });

  it('attaches a resubmit of a live run key whose payer changed between attempts', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: OWNER_FUNDED,
    });
    expect(first.outcome).toBe('executor');
    const resubmit = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: SELF_FUNDED,
    });
    expect(resubmit.outcome).toBe('attach');
  });

  it('replays a settled run key whose payer changed between attempts', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: OWNER_FUNDED,
    });
    if (first.outcome !== 'executor') throw new Error('expected executor');
    const flip = await succeedKeyRow(db, first.fence, { ok: true });
    flip._unsafeUnwrap();
    const resubmit = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: SELF_FUNDED,
    });
    expect(resubmit).toEqual({ outcome: 'replay', response: { ok: true } });
  });
});

describe('conversation runtime — admission hook', () => {
  async function admit(balanceNanoUsd: bigint, estimate: bigint): Promise<AdmissionDecision> {
    const { userId } = await seedWallet(balanceNanoUsd);
    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const walletId = walletRows[0]?.id ?? '';
    const context: RunContext = {
      mode: 'paid',
      payerUserId: userId,
      sender: { kind: 'user', userId },
      // A valid uuid the admission hook reads membership against; no membership
      // row exists, so no member budget scope applies (balance/run-cap only).
      conversationId: crypto.randomUUID(),
      walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId: crypto.randomUUID(),
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    return hooks.admission({ definition: DEFINITION, estimate: nanoUSD(estimate) });
  }

  it('grants admission with the cost-circuit readout when the balance covers the estimate', async () => {
    const decision = await admit(10_000_000n, 1000n);
    expect(decision.admitted).toBe(true);
  });

  it('refuses admission when the estimate exceeds the balance plus the paid cushion', async () => {
    // 500n balance + $0.50 paid cushion still cannot cover a $0.60 estimate.
    const decision = await admit(500n, 600_000_000n);
    expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });
  });

  it('emits admission-refusal telemetry carrying the typed refusal reason (a 402 is debuggable from logs)', async () => {
    // 500n balance + $0.50 paid cushion cannot cover a $0.60 estimate → the
    // decision refuses with reason `insufficient-balance`. The wire code cannot
    // separate an empty balance from funds reserved by a live run, so the
    // content-free telemetry line is the only place that distinction survives.
    const tel = telemetry();
    const { userId } = await seedWallet(500n);
    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const walletId = walletRows[0]?.id ?? '';
    const context: RunContext = {
      mode: 'paid',
      payerUserId: userId,
      sender: { kind: 'user', userId },
      conversationId: crypto.randomUUID(),
      walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId: crypto.randomUUID(),
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
    const hooks: FlowHookBindings = createConversationRuntime({
      db,
      redis,
      telemetry: tel,
      apiKey: 'mock-key',
      searchApiKey: 'mock-key',
      isCI: false,
      chatStores,
      storage: untouchedStorage,
      readEpochPublicKey,
    }).bindHooks(context, DEFINITION);

    const decision = await hooks.admission({
      definition: DEFINITION,
      estimate: nanoUSD(600_000_000n),
    });

    expect(decision.admitted).toBe(false);
    expect(tel.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        errorCode: 'insufficient-balance',
        runId: context.runId,
        conversationId: context.conversationId,
      })
    );
  });

  it('refuses a group turn when the sender is over their durable per-member budget', async () => {
    // The owner funds (ample balance) and the conversation cap is generous; the
    // sender's own durable per-member cap is fully spent, so admission refuses on
    // the member scope — the cap is read from the durable member row, not the
    // conversation budget.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const senderId = await seedBareUser();
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const memberId = await addMember(conversationId, senderId);
    await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 1000n, spentNanoUsd: 2000n });

    const context = paidRunContext({
      userId: ownerId,
      conversationId,
      walletId,
      sender: { kind: 'user', userId: senderId },
    });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision).toEqual({ admitted: false, code: 'GROUP_ALLOCATION_EXHAUSTED' });
  });

  it('admits a group turn on the sender OWN wallet when they have no member budget row (personal fall-through, no group scope)', async () => {
    // Absent durable member row → zero group headroom → the route funds from the
    // signed-in sender's OWN wallet (payer = sender wallet). The admission hook
    // must emit NO group scope: the sender is gated on their own balance alone.
    // Were a member scope emitted, the absent row's zero cap would deny —
    // admission proves it is not, so a member CAN chat before the owner
    // configures budgets (the fix).
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const { userId: senderId } = await seedWallet(10_000_000n);
    const senderWalletId = await ownerWalletId(senderId);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    await addMember(conversationId, senderId); // NO member_budgets row

    const context = paidRunContext({ userId: senderId, conversationId, walletId: senderWalletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('admits a group turn on the sender OWN wallet when the conversation has no budget (personal fall-through, no group scope)', async () => {
    // The conversation cap is 0 (none configured) → zero group headroom → the
    // route funds from the sender's OWN wallet. The admission hook emits NO
    // conversation scope (which, at a 0 cap, would deny): the sender is gated on
    // their own balance and admission succeeds.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const { userId: senderId } = await seedWallet(10_000_000n);
    const senderWalletId = await ownerWalletId(senderId);
    const conversationId = await seedConversation(ownerId, 0n);
    const memberId = await addMember(conversationId, senderId);
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });

    const context = paidRunContext({ userId: senderId, conversationId, walletId: senderWalletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('admits an owner-initiated turn on balance alone (owner funds, never member-capped)', async () => {
    // The owner sends their own turn: no group scopes apply, so even a 0
    // conversation budget and no member row do not gate — the owner funds from
    // their wallet balance.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const conversationId = await seedConversation(ownerId, 0n);
    await addMember(conversationId, ownerId);

    const context = paidRunContext({ userId: ownerId, conversationId, walletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('admits an owner-funded LINK-GUEST turn within the guest member and conversation caps', async () => {
    // The OWNER pays (userId + walletId are the owner's); the guest is the
    // resolved sender. A guest is always owner-funded, so the group scopes gate
    // on the guest's durable member row and the conversation cap.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const guest = await seedGuestMember(conversationId);
    await db
      .insert(memberBudgets)
      .values({ memberId: guest.memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });

    const context = paidRunContext({
      userId: ownerId,
      conversationId,
      walletId,
      sender: { kind: 'linkGuest', linkId: guest.linkId },
    });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('refuses an owner-funded LINK-GUEST turn over the guest per-member cap', async () => {
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const guest = await seedGuestMember(conversationId);
    // The guest's durable per-member cap is fully spent → admission refuses.
    await db
      .insert(memberBudgets)
      .values({ memberId: guest.memberId, budgetNanoUsd: 1000n, spentNanoUsd: 2000n });

    const context = paidRunContext({
      userId: ownerId,
      conversationId,
      walletId,
      sender: { kind: 'linkGuest', linkId: guest.linkId },
    });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision).toEqual({ admitted: false, code: 'GROUP_ALLOCATION_EXHAUSTED' });
  });

  it('binds an owner-funded group turn to BOTH group scopes when the run identity names the PAYER', async () => {
    // The production shape of an owner-funded turn: the run's user id is the
    // OWNER (who pays) and the member rides `sender`. Owner-funding is derived by
    // comparing the two — keying that comparison on the payer alone would make it
    // always false, conclude self-funded, and emit NO group scope, so a member
    // would spend the owner's money with both caps silently absent. That failure
    // is invisible to a verdict assertion: an ample owner balance admits the turn
    // either way. Only the scopes the hold carries distinguish a turn the caps
    // bound from a turn they were never applied to.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const senderId = await seedBareUser();
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const memberId = await addMember(conversationId, senderId);
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });

    const context = paidRunContext({
      userId: ownerId,
      conversationId,
      walletId,
      sender: { kind: 'user', userId: senderId },
    });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    // The SENDER's durable member cap and the conversation cap, in that order —
    // keyed to the member row and the conversation, never to the payer.
    expect(decision.hold.scopeIds).toEqual([
      `member:${memberId}`,
      `conversation:${conversationId}`,
    ]);
  });

  it('maps a non-unavailable admission failure (missing wallet) to its own taxonomy code, not a money refusal', async () => {
    const context: RunContext = {
      mode: 'paid',
      payerUserId: crypto.randomUUID(),
      sender: { kind: 'user', userId: 'x' },
      conversationId: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId: crypto.randomUUID(),
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision).toEqual({ admitted: false, code: 'NOT_FOUND' });
  });

  /**
   * The turn as the route resolves it. The payer wallet comes from the
   * production funding decision rather than from the fixture, so a count keyed
   * on the sender cannot be hidden behind a hand-picked wallet id.
   */
  async function resolveTurn(
    conversationId: string,
    sender: SenderPrincipal
  ): Promise<TurnContext> {
    const resolved = await resolveTurnContext(
      { conversations: createConversationsStores, billing: createBillingStores() },
      db,
      {
        conversationId,
        sender,
        now: new Date(),
        // An empty snapshot prices nothing, so the group comparison is
        // inapplicable and these fixtures fund exactly as they did.
        exposedCatalog: [],
        selection: { turnSources: [{ kind: 'model', id: 'runtime/unpriced' }] },
        promptCharacterCount: 0,
        inputCharacterCount: 0,
      }
    );
    return resolved._unsafeUnwrap();
  }

  /** Admission for a resolved turn, through the hook the run performs it with. */
  function admitTurn(
    context: TurnContext,
    conversationId: string
  ): ReturnType<FlowHookBindings['admission']> {
    const run = paidRunContext({
      userId: context.payerUserId,
      conversationId,
      walletId: context.walletId,
      sender: context.sender,
    });
    const hooks: FlowHookBindings = runtime().bindHooks(run, DEFINITION);
    return hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
  }

  /**
   * A member the owner funds, on a conversation of their own. They hold a
   * funded wallet of their own, so a payer taken from the sender would still
   * name a real wallet — only the wrong one.
   */
  async function seedOwnerFundedMember(
    ownerId: string
  ): Promise<{ readonly conversationId: string; readonly sender: SenderPrincipal }> {
    const { userId } = await seedWallet(10_000_000n);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const memberId = await addMember(conversationId, userId);
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });
    return { conversationId, sender: { kind: 'user', userId } };
  }

  /** A shared link's guest, who holds no wallet and is therefore always owner-funded. */
  async function seedOwnerFundedGuest(
    ownerId: string
  ): Promise<{ readonly conversationId: string; readonly sender: SenderPrincipal }> {
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const guest = await seedGuestMember(conversationId);
    await db
      .insert(memberBudgets)
      .values({ memberId: guest.memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });
    return { conversationId, sender: { kind: 'linkGuest', linkId: guest.linkId } };
  }

  it('refuses the owner a run once other senders have filled the cap on the wallet that funds them', async () => {
    // The cap counts live holds on the PAYER's wallet, and an owner-funded turn
    // pays the owner's wallet whoever sent it — a member of another conversation
    // or a shared link's guest alike. No link of that chain carries a sender
    // term, so other people's runs occupy the owner's own slots.
    const { userId: ownerId } = await seedWallet(10_000_000_000n);
    const inFlight = [
      ...(await Promise.all(
        Array.from({ length: PER_WALLET_CONCURRENT_RUN_CAP - 1 }, () =>
          seedOwnerFundedMember(ownerId)
        )
      )),
      await seedOwnerFundedGuest(ownerId),
    ];

    for (const turn of inFlight) {
      const context = await resolveTurn(turn.conversationId, turn.sender);
      const decision = await admitTurn(context, turn.conversationId);
      expect(decision.admitted).toBe(true);
    }

    const ownConversationId = await seedConversation(ownerId, 0n);
    await addMember(ownConversationId, ownerId);
    const own = await resolveTurn(ownConversationId, { kind: 'user', userId: ownerId });

    expect(await admitTurn(own, ownConversationId)).toEqual({
      admitted: false,
      code: ERROR_CODES.RUN_CAPACITY_REACHED,
    });
  });
});

describe('conversation runtime — free-tier allowance', () => {
  it('admits a solo turn on the free wallet and emits the daily-allowance scope when the purchased balance is spent down', async () => {
    // A registered user whose purchased balance is 0: the route selects the free
    // wallet, and admission must gate the daily allowance (not refuse for lack of
    // balance) — a free wallet's snapshot skips the balance check.
    const { userId, freeWalletId } = await seedFreeTierUser(0n);
    const conversationId = await seedConversation(userId, 0n);
    await addMember(conversationId, userId);

    const context = paidRunContext({ userId, conversationId, walletId: freeWalletId });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    // The ONLY ceiling is the daily allowance — no balance/group scope.
    expect(decision.hold.scopeIds).toEqual([expect.stringMatching(/^allowance:/)]);
  });

  it('admits a group member on their free allowance when their purchased balance is spent down (self-funded fall-through)', async () => {
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const { userId: senderId, freeWalletId } = await seedFreeTierUser(0n);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    await addMember(conversationId, senderId);

    // The route fell through to the sender's OWN free wallet: admission gates the
    // daily allowance alone, never a group scope.
    const context = paidRunContext({ userId: senderId, conversationId, walletId: freeWalletId });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    expect(decision.hold.scopeIds).toEqual([expect.stringMatching(/^allowance:/)]);
  });

  it('refuses a free-tier turn once the daily allowance is spent, and admits again the next UTC day (period-keyed, no reset job)', async () => {
    const { userId, freeWalletId } = await seedFreeTierUser(0n);
    const conversationId = await seedConversation(userId, 0n);
    await addMember(conversationId, userId);
    // Day 1: the whole daily allowance is already spent (one period row).
    await db
      .insert(allowanceSpending)
      .values({ userId, day: DAY1_KEY, spentNanoUsd: DAILY_ALLOWANCE_NANO_USD });

    const day1 = new Date(Date.parse(`${DAY1_KEY}T00:00:00.000Z`) + 12 * HOUR_MS);
    const refused = await runtimeWithNow(() => day1)
      .bindHooks(paidRunContext({ userId, conversationId, walletId: freeWalletId }), DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(refused).toEqual({ admitted: false, code: 'DAILY_ALLOWANCE_EXHAUSTED' });

    // Day 2: a different UTC day keys a fresh (userId, day) row — no reset job —
    // so the allowance is whole again and the same turn admits.
    const day2 = new Date(day1.getTime() + DAY_MS);
    const admitted = await runtimeWithNow(() => day2)
      .bindHooks(paidRunContext({ userId, conversationId, walletId: freeWalletId }), DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(admitted.admitted).toBe(true);
  });

  it('emits the daily-allowance scope for a free-wallet payer even when the conversation resolves to null (defensive)', async () => {
    // The conversation is deleted in the window between route-time validation and
    // the admission hook. The free wallet's balance check is skipped, so the
    // user-keyed allowance cap MUST still bind — it does not depend on the
    // conversation existing.
    const { userId, freeWalletId } = await seedFreeTierUser(0n);
    const context = paidRunContext({
      userId,
      conversationId: crypto.randomUUID(),
      walletId: freeWalletId,
    });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    expect(decision.hold.scopeIds).toEqual([expect.stringMatching(/^allowance:/)]);
  });

  it('emits no scopes for a purchased payer when the conversation resolves to null (balance still binds)', async () => {
    const { userId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(userId);
    const context = paidRunContext({
      userId,
      conversationId: crypto.randomUUID(),
      walletId,
    });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    expect(decision.hold.scopeIds).toEqual([]);
  });
});

describe('conversation runtime — executor', () => {
  it('runs a definition to a failed outcome and honors a pre-ready stop', async () => {
    const hooks: ChatHookBindings = {
      admission: () =>
        Promise.resolve({
          admitted: true,
          holdRef: 'h',
          circuit: {
            estimateNanoUsd: 1n,
            costCircuitMultiplier: 5n,
            costCircuitLimitNanoUsd: 5n,
          },
        }),
      settlement: () => Promise.resolve(),
      answerMessageIds: new Map(),
      assistantMessageIds: [],
    };
    const handle = runtime().executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks,
      runKey: crypto.randomUUID(),
      emit: () => {},
    });
    handle.stop('user-stop');
    const outcome = await handle.done;
    expect(outcome.outcome).toBe('stopped');
    // The build has settled and the inner handle exists; a stop here exercises
    // the post-ready branch (delegating straight to the inner handle).
    handle.stop('user-stop');
  });

  it('honors an abort that lands before the executor is built', async () => {
    const hooks: ChatHookBindings = {
      admission: () =>
        Promise.resolve({
          admitted: true,
          holdRef: 'h',
          circuit: {
            estimateNanoUsd: 1n,
            costCircuitMultiplier: 5n,
            costCircuitLimitNanoUsd: 5n,
          },
        }),
      settlement: () => Promise.resolve(),
      answerMessageIds: new Map(),
      assistantMessageIds: [],
    };
    const handle = runtime().executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks,
      runKey: crypto.randomUUID(),
      emit: () => {},
    });
    handle.abort('deadline-hard');
    const outcome = await handle.done;
    expect(outcome.outcome).toBe('stopped');
  });

  it('runs to completion without a pre-ready stop', async () => {
    const hooks: ChatHookBindings = {
      admission: () =>
        Promise.resolve({
          admitted: true,
          holdRef: 'h',
          circuit: {
            estimateNanoUsd: 1n,
            costCircuitMultiplier: 5n,
            costCircuitLimitNanoUsd: 5n,
          },
        }),
      settlement: () => Promise.resolve(),
      answerMessageIds: new Map(),
      assistantMessageIds: [],
    };
    const handle = runtime().executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks,
      runKey: crypto.randomUUID(),
      emit: () => {},
    });
    // No stop before the build resolves — exercises the not-stopped branch.
    const outcome = await handle.done;
    expect(outcome.outcome).toBe('succeeded');
  });

  const okHooks: ChatHookBindings = {
    admission: () =>
      Promise.resolve({
        admitted: true,
        holdRef: 'h',
        circuit: { estimateNanoUsd: 1n, costCircuitMultiplier: 5n, costCircuitLimitNanoUsd: 5n },
      }),
    settlement: () => Promise.resolve(),
    answerMessageIds: new Map(),
    assistantMessageIds: [],
  };

  it('builds the mock provider per run when the env gate is enabled and the run carries directives', async () => {
    const rt = createConversationRuntime({
      db,
      redis,
      telemetry: telemetry(),
      apiKey: 'mock-key',
      searchApiKey: 'mock-key',
      isCI: false,
      mockProviderEnabled: true,
      chatStores,
      storage: untouchedStorage,
      readEpochPublicKey,
    });
    const handle = rt.executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks: okHooks,
      runKey: crypto.randomUUID(),
      mockDirectives: { classifierResolution: 'a/model' },
      emit: () => {},
    });
    const outcome = await handle.done;
    expect(outcome.outcome).toBe('succeeded');
  });

  it('forwards an abort to a run already streaming, which ends stopped', async () => {
    const model = `chat-abort/${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(modelCatalog).values({
      modelId: model,
      descriptor: {
        id: model,
        provider: 'p',
        version: '3',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: {
          kind: 'tokens',
          anchor: { base: { input: '2500', output: '10000' }, tiers: [] },
        },
        zdrReachable: true,
        releasedAt: secondsAt(TEST_DAY_START),
        fetchedAt: 0,
      },
    });
    try {
      const silent = telemetry();
      const built = await buildTurnDefinition({ db, telemetry: silent }, model, {});
      const definition = built._unsafeUnwrap();
      const rt = createConversationRuntime({
        db,
        redis,
        telemetry: silent,
        apiKey: 'mock-key',
        searchApiKey: 'mock-key',
        isCI: false,
        mockProviderEnabled: true,
        chatStores,
        storage: untouchedStorage,
        readEpochPublicKey,
      });
      let markParked!: () => void;
      const parked = new Promise<void>((resolve) => {
        markParked = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handle = rt.executor.start({
        definition,
        inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: 'hello' } },
        hooks: okHooks,
        runKey: crypto.randomUUID(),
        mockDirectives: { holdPrimaryStream: true },
        awaitStreamRelease: () => {
          markParked();
          return released;
        },
        emit: () => {},
      });
      await parked;
      handle.abort('deadline-hard');
      release();
      await expect(handle.done).resolves.toEqual({ outcome: 'stopped' });
    } finally {
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
    }
  });

  describe('a run already streaming, told to stop or to abort', () => {
    const PROMPT = 'hello';
    const FULL_ANSWER = `${MOCK_ECHO_AFFIXES.prefix}${PROMPT}${MOCK_ECHO_AFFIXES.suffix}`;

    /**
     * Starts a one-node turn on the mock provider, holds its stream after the
     * first chunk, forwards `halt` through the runtime's handle, releases the
     * stream, and returns the answer text the run settled.
     */
    async function settledAnswerAfter(
      halt: (handle: FlowRunHandle) => void
    ): Promise<string | undefined> {
      const model = `chat-halt/${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(modelCatalog).values({
        modelId: model,
        descriptor: {
          id: model,
          provider: 'p',
          version: '3',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: ['streaming'],
          limits: { contextLength: 128_000 },
          pricing: {
            kind: 'tokens',
            anchor: { base: { input: '2500', output: '10000' }, tiers: [] },
          },
          zdrReachable: true,
          releasedAt: secondsAt(TEST_DAY_START),
          fetchedAt: 0,
        },
      });
      try {
        const silent = telemetry();
        const built = await buildTurnDefinition({ db, telemetry: silent }, model, {});
        const rt = createConversationRuntime({
          db,
          redis,
          telemetry: silent,
          apiKey: 'mock-key',
          searchApiKey: 'mock-key',
          isCI: false,
          mockProviderEnabled: true,
          chatStores,
          storage: untouchedStorage,
          readEpochPublicKey,
        });
        let markParked!: () => void;
        const parked = new Promise<void>((resolve) => {
          markParked = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const settled: SettlementRequest[] = [];
        const handle = rt.executor.start({
          definition: built._unsafeUnwrap(),
          inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: PROMPT } },
          hooks: {
            ...okHooks,
            settlement: (request) => {
              settled.push(request);
              return Promise.resolve();
            },
          },
          runKey: crypto.randomUUID(),
          mockDirectives: { holdPrimaryStream: true },
          awaitStreamRelease: () => {
            markParked();
            return released;
          },
          emit: () => {},
        });
        await parked;
        halt(handle);
        release();
        await expect(handle.done).resolves.toEqual({ outcome: 'stopped' });
        const answer = settled[0]?.outputs['answer'];
        return answer?.kind === 'text' ? answer.text : undefined;
      } finally {
        await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
      }
    }

    it('cuts the in-flight stream when the abort is forwarded', async () => {
      const answer = await settledAnswerAfter((handle) => {
        handle.abort('deadline-hard');
      });
      expect(answer).not.toBe(FULL_ANSWER);
      expect(FULL_ANSWER.startsWith(answer ?? '')).toBe(true);
    });

    it('lets the in-flight stream finish when the stop is forwarded', async () => {
      const answer = await settledAnswerAfter((handle) => {
        handle.stop('user-stop');
      });
      expect(answer).toBe(FULL_ANSWER);
    });
  });

  it('reuses the cached real executor across runs on one runtime', async () => {
    const rt = runtime();
    const startOne = (): Promise<FlowRunOutcome> =>
      rt.executor.start({
        definition: DEFINITION,
        inputs: {},
        hooks: okHooks,
        runKey: crypto.randomUUID(),
        emit: () => {},
      }).done;
    // Two real-path runs on one runtime — the second reuses the cached executor.
    const first = await startOne();
    const second = await startOne();
    expect(first.outcome).toBe('succeeded');
    expect(second.outcome).toBe('succeeded');
  });
});

describe('conversation runtime — run money/lease capabilities', () => {
  function paidContext(userId: string, walletId: string, runId: string): RunContext {
    return {
      mode: 'paid',
      payerUserId: userId,
      sender: { kind: 'user', userId },
      conversationId: crypto.randomUUID(),
      walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId,
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
  }

  async function seededWalletId(balanceNanoUsd: bigint): Promise<{
    userId: string;
    walletId: string;
  }> {
    const { userId } = await seedWallet(balanceNanoUsd);
    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const walletId = walletRows[0]?.id;
    if (walletId === undefined) throw new Error('wallet seed failed');
    return { userId, walletId };
  }

  it('admits the second turn immediately once the first run releases its hold', async () => {
    // The estimate consumes more than half the spendable funds (balance + the
    // $0.50 paid cushion), so two live holds can never coexist — only the
    // release (not TTL expiry) lets the next turn in.
    const { userId, walletId } = await seededWalletId(1_000_000_000n);
    const rt = runtime();
    const firstRunId = crypto.randomUUID();
    const firstHooks = rt.bindHooks(paidContext(userId, walletId, firstRunId), DEFINITION);
    const first = await firstHooks.admission({
      definition: DEFINITION,
      estimate: nanoUSD(800_000_000n),
    });
    expect(first.admitted).toBe(true);

    const secondHooks = rt.bindHooks(
      paidContext(userId, walletId, crypto.randomUUID()),
      DEFINITION
    );
    const blocked = await secondHooks.admission({
      definition: DEFINITION,
      estimate: nanoUSD(800_000_000n),
    });
    expect(blocked).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });

    if (!first.admitted || first.hold === undefined) throw new Error('expected a granted hold');
    await rt.releaseHold(first.hold);

    const admitted = await secondHooks.admission({
      definition: DEFINITION,
      estimate: nanoUSD(800_000_000n),
    });
    expect(admitted.admitted).toBe(true);
  });

  it('re-executes exactly once after failRun frees a failed run key', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    if (first.outcome !== 'executor') throw new Error('expected executor');

    await rt.failRun(first.fence);

    // The retry reclaims the failed row as a fresh executor (claims advanced),
    // never a bogus attach to the dead run and never a 409.
    const retry = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(retry.outcome).toBe('executor');
    if (retry.outcome === 'executor') expect(retry.fence.claims).toBe(2);

    // Serialized: a concurrent second retry attaches to the reclaimed run.
    const concurrent = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(concurrent.outcome).toBe('attach');
  });

  it('failRun after a settled key row is a fenced no-op (the replay survives)', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    if (first.outcome !== 'executor') throw new Error('expected executor');
    const flip = await succeedKeyRow(db, first.fence, { ok: true });
    flip._unsafeUnwrap();

    await rt.failRun(first.fence);

    const replay = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(replay).toEqual({ outcome: 'replay', response: { ok: true } });
  });

  it('heartbeats the live fence and reports a superseded one lost', async () => {
    const rt = runtime();
    const claim = await rt.claimRun({
      runKey: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    if (claim.outcome !== 'executor') throw new Error('expected executor');
    await expect(rt.heartbeat(claim.fence)).resolves.toBe('alive');
    // A zombie's fence (stale claim count) touches zero rows.
    await expect(rt.heartbeat({ ...claim.fence, claims: claim.fence.claims - 1 })).resolves.toBe(
      'lost'
    );
  });
});
