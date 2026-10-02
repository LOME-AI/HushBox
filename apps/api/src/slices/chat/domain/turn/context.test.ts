import { describe, expect, it } from 'vitest';
import { PAID_CUSHION_NANO_USD } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { okAsync } from '../../../../lib/result/index.js';
import { resolveTurnContext } from './context.js';
import { turnMinCost } from './pricing.js';
import { DAILY_ALLOWANCE_NANO_USD } from '../../../billing/index.js';
import type { ConversationsStoresFactory, ResolveTurnContextDeps } from './context.js';
import type { BillingStores } from '../../../billing/index.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { TurnPricingSelection } from './pricing.js';
import type { Database } from '@hushbox/db';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

const DB = {} as Database;
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

/** A catalog row the money layer can price, so the freeze has a rate to price on. */
function descriptorOf(id: string): ModelDescriptor {
  return {
    id,
    provider: 'openrouter',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 8000, maxOutputTokens: 4000 },
    pricing: tokenPricingFixture({ input: 10n, output: 20n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

const PRICED_MODEL = 'freeze/priced';
/** The catalog snapshot the freeze prices its selection against. */
const CATALOG = [descriptorOf(PRICED_MODEL)];
/** The client selection the freeze prices, unless a test names another. */
const SELECTION: TurnPricingSelection = { turnSources: [{ kind: 'model', id: PRICED_MODEL }] };
const PROMPT_CHARS = 400;
/** The new user message inside {@link PROMPT_CHARS} — the storage basis. */
const NEW_MESSAGE_CHARS = 100;

/** What the shared selection costs at a given prompt length; it always prices. */
function pricedMinimum(promptCharacterCount: number): bigint {
  const priced = turnMinCost(CATALOG, SELECTION, {
    promptCharacterCount,
    inputCharacterCount: NEW_MESSAGE_CHARS,
  });
  if (priced === undefined) throw new Error('the shared selection priced no minimum');
  return priced;
}

/**
 * The minimum the shared selection prices — the figure every frozen-inputs
 * expectation below carries, and the boundary the headroom fixtures are built
 * around. Derived, deliberately: the BOUNDARY fixtures are stated relative to
 * it (`CHEAP_TURN - 1n` is headroom one nano short of the turn, whatever the
 * turn costs), so they go on testing the same edge when the composition moves.
 * The fixtures that only need AMPLE headroom size their caps with fixed
 * amounts instead, and are relative to nothing: a composition change large
 * enough to price a turn past those caps flips their payer, and they say so by
 * failing rather than by passing on a fixture that no longer models what it
 * claims. What the composition prices is not this file's subject and is
 * asserted where it is composed.
 */
const CHEAP_TURN = pricedMinimum(PROMPT_CHARS);

const ARGS = {
  conversationId: 'c1',
  sender: { kind: 'user', userId: 'u1' } as const,
  now: NOW,
  exposedCatalog: CATALOG,
  selection: SELECTION,
  promptCharacterCount: PROMPT_CHARS,
  inputCharacterCount: NEW_MESSAGE_CHARS,
};
/** The sender and payer a self-funded user turn (sender 'u1') always yields. */
const USER_FIELDS = {
  sender: { kind: 'user', userId: 'u1' },
  payerUserId: 'u1',
} as const;

interface WalletStub {
  readonly id: string;
  readonly type: string;
  readonly balanceNanoUsd?: bigint;
}

interface StoreStubs {
  readonly member?: { readonly id: string } | null;
  /** The active link-guest member row `resolveCallerMember` returns for a guest sender. */
  readonly linkGuest?: { readonly id: string; readonly privilege?: string } | null;
  readonly conversation?: {
    readonly currentEpoch: number;
    readonly ownerUserId?: string;
    readonly conversationBudgetNanoUsd?: bigint;
  } | null;
  /** Per-user wallet rows; the funding decision reads owner and sender separately. */
  readonly walletsByUser?: Record<string, readonly WalletStub[]>;
  /** The sender's durable per-member budget row (absent = no group headroom). */
  readonly memberBudget?: { readonly budgetNanoUsd: bigint; readonly spentNanoUsd: bigint } | null;
  /** The conversation's cumulative spend against its durable cap. */
  readonly conversationSpent?: bigint;
  /** The payer's free-tier allowance already spent today (defaults 0). */
  readonly allowanceSpent?: bigint;
  readonly fork?: { readonly id: string } | null;
  /** Records the userIds the wallet lookup was scoped to, in call order. */
  readonly walletLookups?: string[];
}

function deps(stubs: StoreStubs): ResolveTurnContextDeps {
  const conversations = (() => ({
    members: {
      activeByUser: () => okAsync(stubs.member ?? null),
      activeLinkGuest: () =>
        okAsync(
          stubs.linkGuest == null
            ? null
            : { member: stubs.linkGuest, publicKey: new Uint8Array(), displayName: null }
        ),
    },
    conversations: {
      get: () =>
        okAsync(
          stubs.conversation == null
            ? null
            : {
                currentEpoch: stubs.conversation.currentEpoch,
                // Default the owner to the caller so an unset owner is a SOLO turn.
                ownerUserId: stubs.conversation.ownerUserId ?? ARGS.sender.userId,
                conversationBudgetNanoUsd: stubs.conversation.conversationBudgetNanoUsd ?? 0n,
              }
        ),
    },
    forks: { byId: () => okAsync(stubs.fork ?? null) },
    epochs: { conversationsWithDepartedHolders: () => okAsync(new Set<string>()) },
  })) as unknown as ConversationsStoresFactory;
  const billing = {
    readWallets: (_db: Database, userId: string) => {
      stubs.walletLookups?.push(userId);
      return okAsync(stubs.walletsByUser?.[userId] ?? []);
    },
    readMemberBudget: () => okAsync(stubs.memberBudget ?? null),
    readConversationSpent: () => okAsync(stubs.conversationSpent ?? 0n),
    readAllowanceSpent: () => okAsync(stubs.allowanceSpent ?? 0n),
  } as unknown as BillingStores;
  return { conversations, billing };
}

describe('resolveTurnContext', () => {
  it('refuses a non-member with forbidden', async () => {
    const result = await resolveTurnContext(deps({ member: null }), DB, ARGS);
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a missing conversation with not_found', async () => {
    const result = await resolveTurnContext(
      deps({ member: { id: 'm1' }, conversation: null }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('refuses a solo caller with no purchased wallet with forbidden', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: { u1: [{ id: 'w', type: 'free' }] },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('resolves the current epoch and the solo caller purchased wallet', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'paid-w',
      funding: { spendableNanoUsd: 1_000_000n + PAID_CUSHION_NANO_USD, kind: 'purchased' },
      fundingDecisionInputs: {
        isSolo: true,
        isGuest: false,
        memberRemainingNanoUsd: 0n,
        conversationRemainingNanoUsd: 0n,
        ownerPurchasedBalanceNanoUsd: 1_000_000n,
        callerOwnPurchasedBalanceNanoUsd: 1_000_000n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it("selects the solo caller's free wallet when the purchased balance is spent to zero", async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: 0n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'free-w',
      funding: { spendableNanoUsd: DAILY_ALLOWANCE_NANO_USD, kind: 'free' },
      fundingDecisionInputs: {
        isSolo: true,
        isGuest: false,
        memberRemainingNanoUsd: 0n,
        conversationRemainingNanoUsd: 0n,
        ownerPurchasedBalanceNanoUsd: 0n,
        callerOwnPurchasedBalanceNanoUsd: 0n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it("selects the solo caller's free wallet when the purchased balance is negative", async () => {
    // The founder ruling: a NEGATIVE purchased balance (a settled-into-the-red
    // wallet) draws the free tier, not the purchased wallet.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: -100n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'free-w',
      funding: { spendableNanoUsd: DAILY_ALLOWANCE_NANO_USD, kind: 'free' },
      fundingDecisionInputs: {
        isSolo: true,
        isGuest: false,
        memberRemainingNanoUsd: 0n,
        conversationRemainingNanoUsd: 0n,
        ownerPurchasedBalanceNanoUsd: -100n,
        callerOwnPurchasedBalanceNanoUsd: -100n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it("falls through to the SENDER's free wallet when the group headroom is exhausted and their purchased balance is spent down", async () => {
    // The sender has no member-budget row (zero group headroom) → self-funds; the
    // sender's purchased wallet is spent to zero → the free wallet is the payer.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: null,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
          u1: [
            { id: 'sender-free', type: 'free', balanceNanoUsd: 0n },
            { id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 0n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'sender-free',
      funding: { spendableNanoUsd: DAILY_ALLOWANCE_NANO_USD, kind: 'free' },
      fundingDecisionInputs: {
        isSolo: false,
        isGuest: false,
        memberRemainingNanoUsd: 0n,
        conversationRemainingNanoUsd: 1_000_000n,
        ownerPurchasedBalanceNanoUsd: 1_000_000n,
        callerOwnPurchasedBalanceNanoUsd: 0n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it("funds an owner-funded group turn from the OWNER's wallet, not the sending member's", async () => {
    // The sender ('u1') is a member; the owner ('owner-9') is a different user
    // with positive group headroom (member cap, conversation cap, owner balance
    // all ample), so the turn is owner-funded — the payer is the OWNER's wallet.
    const walletLookups: string[] = [];
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 2_000_000n,
        },
        memberBudget: { budgetNanoUsd: 2_000_000n, spentNanoUsd: 0n },
        conversationSpent: 0n,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 2_000_000n }],
        },
        walletLookups,
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      // The payer is the OWNER: the charged wallet is theirs, so the billed
      // row's payer must name them and not the sending member.
      payerUserId: 'owner-9',
      epochNumber: 3,
      walletId: 'owner-paid-w',
      funding: { spendableNanoUsd: 2_000_000n, kind: 'purchased' },
      fundingDecisionInputs: {
        isSolo: false,
        isGuest: false,
        memberRemainingNanoUsd: 2_000_000n,
        conversationRemainingNanoUsd: 2_000_000n,
        ownerPurchasedBalanceNanoUsd: 2_000_000n,
        callerOwnPurchasedBalanceNanoUsd: 0n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
    // Only the owner's wallet is read on the owner-funded branch.
    expect(walletLookups).toEqual(['owner-9']);
  });

  it("falls through to the SENDER's own wallet when the group headroom is exhausted (personal)", async () => {
    // The sender ('u1') has no member-budget row (zero group headroom), so even
    // with an ample-balance owner the route funds from the sender's OWN wallet.
    const walletLookups: string[] = [];
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: null, // absent → zero cap → zero headroom → fall through
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
        walletLookups,
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'sender-paid-w',
      funding: { spendableNanoUsd: 1_000_000n + PAID_CUSHION_NANO_USD, kind: 'purchased' },
      fundingDecisionInputs: {
        isSolo: false,
        isGuest: false,
        memberRemainingNanoUsd: 0n,
        conversationRemainingNanoUsd: 1_000_000n,
        ownerPurchasedBalanceNanoUsd: 1_000_000n,
        callerOwnPurchasedBalanceNanoUsd: 1_000_000n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
    // The owner is read for the headroom check, then the sender for the payer.
    expect(walletLookups).toEqual(['owner-9', 'u1']);
  });

  it("falls through to the sender's wallet when the owner has no purchased wallet at all", async () => {
    // The owner never funded a wallet → owner balance reads as zero → zero group
    // headroom → the turn funds from the sender's own wallet.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-free', type: 'free' }], // no purchased wallet
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'sender-paid-w',
      funding: { spendableNanoUsd: 1_000_000n + PAID_CUSHION_NANO_USD, kind: 'purchased' },
      fundingDecisionInputs: {
        isSolo: false,
        isGuest: false,
        memberRemainingNanoUsd: 1_000_000n,
        conversationRemainingNanoUsd: 1_000_000n,
        ownerPurchasedBalanceNanoUsd: 0n,
        callerOwnPurchasedBalanceNanoUsd: 1_000_000n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it('refuses a fallen-through group turn when the sender has no purchased wallet', async () => {
    // Group headroom exhausted (owner in the red) → fall through to the sender,
    // who has no purchased wallet → forbidden.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 0n }],
          u1: [{ id: 'sender-free', type: 'free' }],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });

  it('refuses a send onto a missing fork with not_found', async () => {
    const result = await resolveTurnContext(
      deps({ member: { id: 'm1' }, conversation: { currentEpoch: 3 }, fork: null }),
      DB,
      { ...ARGS, forkId: 'gone' }
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('resolves a solo send onto an existing fork', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        fork: { id: 'f1' },
        walletsByUser: { u1: [{ id: 'paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }] },
      }),
      DB,
      { ...ARGS, forkId: 'f1' }
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      epochNumber: 3,
      walletId: 'paid-w',
      funding: { spendableNanoUsd: 1_000_000n + PAID_CUSHION_NANO_USD, kind: 'purchased' },
      fundingDecisionInputs: {
        isSolo: true,
        isGuest: false,
        memberRemainingNanoUsd: 0n,
        conversationRemainingNanoUsd: 0n,
        ownerPurchasedBalanceNanoUsd: 1_000_000n,
        callerOwnPurchasedBalanceNanoUsd: 1_000_000n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it("surfaces the free payer's REMAINING daily allowance (limit minus today's spend)", async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        allowanceSpent: 1_000_000n,
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: 0n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap().funding).toEqual({
      spendableNanoUsd: DAILY_ALLOWANCE_NANO_USD - 1_000_000n,
      kind: 'free',
    });
  });

  it('clamps an overspent daily allowance to zero remaining (admission then refuses)', async () => {
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: { currentEpoch: 3 },
        allowanceSpent: DAILY_ALLOWANCE_NANO_USD + 5n,
        walletsByUser: {
          u1: [
            { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
            { id: 'paid-w', type: 'purchased', balanceNanoUsd: 0n },
          ],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap().funding).toEqual({ spendableNanoUsd: 0n, kind: 'free' });
  });

  it('surfaces the group MIN (member cap, conversation cap, owner spendable funds) as the owner-funded spendable', async () => {
    // memberRemaining = 7M − 2M = 5M is the binding dimension:
    // conversationRemaining = 20M − 1M = 19M, ownerBalance = 50M. Every
    // dimension clears the minimum the freeze prices, so the MIN is what the
    // comparison sees and what the owner-funded turn spends.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 20_000_000n,
        },
        memberBudget: { budgetNanoUsd: 7_000_000n, spentNanoUsd: 2_000_000n },
        conversationSpent: 1_000_000n,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 50_000_000n }],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      ...USER_FIELDS,
      payerUserId: 'owner-9',
      epochNumber: 3,
      walletId: 'owner-paid-w',
      funding: { spendableNanoUsd: 5_000_000n, kind: 'purchased' },
      fundingDecisionInputs: {
        isSolo: false,
        isGuest: false,
        memberRemainingNanoUsd: 5_000_000n,
        conversationRemainingNanoUsd: 19_000_000n,
        ownerPurchasedBalanceNanoUsd: 50_000_000n,
        callerOwnPurchasedBalanceNanoUsd: 0n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it("freezes the group MIN itself as the payer's spendable funds, with nothing added on top", async () => {
    // A 1¢ member allocation against a solvent owner and an ample conversation
    // cap. The frozen figure IS the min: adding the owner's cushion to it would
    // size the turn at $0.51 and hand admission a member scope it must refuse.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000_000n,
        },
        memberBudget: { budgetNanoUsd: 10_000_000n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000_000n }],
        },
      }),
      DB,
      ARGS
    );
    expect(result._unsafeUnwrap().funding).toEqual({
      spendableNanoUsd: 10_000_000n,
      kind: 'purchased',
    });
  });

  it("funds a member's turn from the OWNER's cushion when the owner's own balance is the binding term", async () => {
    // The owner's balance is one nano short of the turn's minimum, and both
    // group caps are ample. The cushion belongs to the wallet, not to the
    // transaction, so the same money that would fund the owner's own turn funds
    // the member's — and the frozen figure is the cushioned owner balance,
    // because that is now the tightest dimension.
    const ownerBalance = CHEAP_TURN - 1n;
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 10_000_000_000n,
        },
        memberBudget: { budgetNanoUsd: 10_000_000_000n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: ownerBalance }],
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 10_000_000_000n }],
        },
      }),
      DB,
      ARGS
    );
    const context = result._unsafeUnwrap();
    expect(context.payerUserId).toBe('owner-9');
    expect(context.walletId).toBe('owner-paid-w');
    expect(context.funding.spendableNanoUsd).toBe(ownerBalance + PAID_CUSHION_NANO_USD);
  });

  it('falls a member through to their OWN wallet when the headroom cannot cover the turn', async () => {
    // Headroom is positive but one nano below the minimum the freeze PRICED, so
    // the owner can never fund this send: freezing them as payer would hand
    // admission a member scope it must refuse, on this attempt and every retry.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 10_000_000_000n,
        },
        memberBudget: { budgetNanoUsd: CHEAP_TURN - 1n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 10_000_000_000n }],
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 10_000_000_000n }],
        },
      }),
      DB,
      ARGS
    );
    const context = result._unsafeUnwrap();
    expect(context.payerUserId).toBe('u1');
    expect(context.walletId).toBe('sender-paid-w');
    expect(context.fundingDecisionInputs.minTurnCostNanoUsd).toBe(CHEAP_TURN);
  });

  it('funds the OWNER when the headroom exactly covers the minimum', async () => {
    // The boundary is inclusive: headroom equal to the minimum buys a runnable
    // ceiling, so the group still pays. One nano more of headroom than the test
    // above, and the payer changes.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 10_000_000_000n,
        },
        memberBudget: { budgetNanoUsd: CHEAP_TURN, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 10_000_000_000n }],
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 10_000_000_000n }],
        },
      }),
      DB,
      ARGS
    );
    const context = result._unsafeUnwrap();
    expect(context.payerUserId).toBe('owner-9');
    expect(context.walletId).toBe('owner-paid-w');
  });

  it('prices a longer prompt higher, so the frozen minimum tracks the selection', async () => {
    // Two resolutions differing in nothing but the prompt length. A freeze that
    // echoed a caller's number could not tell them apart.
    const stubs = {
      member: { id: 'm1' },
      conversation: { currentEpoch: 3 },
      walletsByUser: {
        u1: [{ id: 'paid-w', type: 'purchased', balanceNanoUsd: 1_000_000_000n }],
      },
    } as const;
    const short = await resolveTurnContext(deps(stubs), DB, ARGS);
    const long = await resolveTurnContext(deps(stubs), DB, {
      ...ARGS,
      promptCharacterCount: PROMPT_CHARS * 4,
    });
    const shortMinimum = short._unsafeUnwrap().fundingDecisionInputs.minTurnCostNanoUsd;
    const longMinimum = long._unsafeUnwrap().fundingDecisionInputs.minTurnCostNanoUsd;
    expect(shortMinimum).toBeDefined();
    expect(longMinimum).toBeGreaterThan(shortMinimum ?? 0n);
  });

  it('prices a longer new message higher, so the frozen minimum tracks what rests', async () => {
    // Two resolutions differing in nothing but the NEW message's length, at one
    // prompt total. The storage the freeze reserves is what settlement bills,
    // and settlement bills the new message alone — so a freeze that read the
    // whole prompt could not tell these two apart.
    const stubs = {
      member: { id: 'm1' },
      conversation: { currentEpoch: 3 },
      walletsByUser: {
        u1: [{ id: 'paid-w', type: 'purchased', balanceNanoUsd: 1_000_000_000n }],
      },
    } as const;
    const storesNothing = await resolveTurnContext(deps(stubs), DB, {
      ...ARGS,
      inputCharacterCount: 0,
    });
    const storesMessage = await resolveTurnContext(deps(stubs), DB, ARGS);
    const withoutStorage = storesNothing._unsafeUnwrap().fundingDecisionInputs.minTurnCostNanoUsd;
    const withStorage = storesMessage._unsafeUnwrap().fundingDecisionInputs.minTurnCostNanoUsd;
    expect(withoutStorage).toBeDefined();
    expect(withStorage).toBeGreaterThan(withoutStorage ?? 0n);
  });

  it('leaves the comparison inapplicable when nothing in the selection prices', async () => {
    // No price is reachable at all — an unknown model, which the turn build
    // refuses below — so there is nothing to compare and the owner funds any
    // positive headroom. Every turn SHAPE prices a minimum; only an absent
    // price reaches here.
    const result = await resolveTurnContext(
      deps({
        member: { id: 'm1' },
        conversation: {
          currentEpoch: 3,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: 900n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
          u1: [{ id: 'sender-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
      }),
      DB,
      { ...ARGS, selection: { turnSources: [{ kind: 'model', id: 'freeze/unknown' }] } }
    );
    const context = result._unsafeUnwrap();
    expect(context.payerUserId).toBe('owner-9');
    expect(context.fundingDecisionInputs.minTurnCostNanoUsd).toBeUndefined();
  });

  const GUEST_ARGS = {
    conversationId: 'c1',
    sender: { kind: 'linkGuest', linkId: 'l1' } as const,
    now: NOW,
    exposedCatalog: CATALOG,
    selection: SELECTION,
    promptCharacterCount: PROMPT_CHARS,
    inputCharacterCount: NEW_MESSAGE_CHARS,
  };

  it('funds a WRITE link-guest turn from the OWNER wallet and attributes the guest as sender', async () => {
    const result = await resolveTurnContext(
      deps({
        linkGuest: { id: 'gm1' },
        conversation: {
          currentEpoch: 4,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 2_000_000n,
        },
        memberBudget: { budgetNanoUsd: 2_000_000n, spentNanoUsd: 0n },
        conversationSpent: 0n,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 2_000_000n }],
        },
      }),
      DB,
      GUEST_ARGS
    );
    expect(result._unsafeUnwrap()).toEqual({
      epochNumber: 4,
      walletId: 'owner-paid-w',
      funding: { spendableNanoUsd: 2_000_000n, kind: 'purchased' },
      // The guest is the sender (its linkId persists as messages.senderId); the
      // OWNER pays.
      sender: { kind: 'linkGuest', linkId: 'l1' },
      payerUserId: 'owner-9',
      fundingDecisionInputs: {
        isSolo: false,
        isGuest: true,
        memberRemainingNanoUsd: 2_000_000n,
        conversationRemainingNanoUsd: 2_000_000n,
        ownerPurchasedBalanceNanoUsd: 2_000_000n,
        callerOwnPurchasedBalanceNanoUsd: 0n,
        minTurnCostNanoUsd: CHEAP_TURN,
      },
    });
  });

  it('DENIES a link-guest turn when the owner headroom is exhausted (a guest has no wallet)', async () => {
    // Member cap zeroed (no row) → group headroom ≤ 0; a user would self-fund,
    // but a guest has no wallet to fall through to, so the send is refused.
    const result = await resolveTurnContext(
      deps({
        linkGuest: { id: 'gm1' },
        conversation: {
          currentEpoch: 4,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: null,
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 1_000_000n }],
        },
      }),
      DB,
      GUEST_ARGS
    );
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('forbidden');
    // The denial is TYPED on the wire: the route layer projects the carried
    // wireCode (GROUP_BUDGET_EXHAUSTED, matching the shared funding core's
    // refusal code) instead of the generic FORBIDDEN, so the client can show
    // the guest the owner-allocated-budget remedy from the shared copy map.
    expect(error.wireCode).toBe('GROUP_BUDGET_EXHAUSTED');
  });

  it('DENIES a link-guest turn whose headroom is positive but below the minimum', async () => {
    // The guest boundary does not move with the comparison: headroom that
    // cannot cover the turn refuses the guest exactly as an exhausted one does,
    // because a guest holds no wallet to fall through to (§Group Funding 2).
    const result = await resolveTurnContext(
      deps({
        linkGuest: { id: 'gm1' },
        conversation: {
          currentEpoch: 4,
          ownerUserId: 'owner-9',
          conversationBudgetNanoUsd: 1_000_000n,
        },
        memberBudget: { budgetNanoUsd: CHEAP_TURN - 1n, spentNanoUsd: 0n },
        walletsByUser: {
          'owner-9': [{ id: 'owner-paid-w', type: 'purchased', balanceNanoUsd: 10_000_000_000n }],
        },
      }),
      DB,
      GUEST_ARGS
    );
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('forbidden');
    expect(error.wireCode).toBe('GROUP_BUDGET_EXHAUSTED');
  });

  it('refuses a link-guest turn when no active guest membership resolves', async () => {
    const result = await resolveTurnContext(
      deps({ linkGuest: null, conversation: { currentEpoch: 4, ownerUserId: 'owner-9' } }),
      DB,
      GUEST_ARGS
    );
    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });
});
