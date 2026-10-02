import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { gatedTurnContext, memberAdmits, regenerateTierGateMode } from './gated-turn-context.js';
import type {
  GatedCallerAction,
  GatedTurnCaller,
  GatedTurnContextDeps,
  GatedTurnRequest,
  PremiumTierGateMode,
  RegenerateTierGateRequest,
} from './gated-turn-context.js';
import type { ConversationCaller, ConversationsStores } from '../../../conversations/index.js';
import type { ConversationsStoresFactory } from './context.js';
import type { BillingStores } from '../../../billing/index.js';
import type { Database } from '@hushbox/db';
import type { MemberPrivilege } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

/** A release instant long enough ago to sit outside the recency window. */
const RELEASED_OUTSIDE_RECENCY_WINDOW_MS = TEST_DAY_START - 40_000 * HOUR_MS;

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

const CHEAP_MODEL = 'gated/cheap';
const PREMIUM_MODEL = 'gated/premium';
const DISABLED_MODEL = 'gated/disabled';

/**
 * A catalog row as the store reads it. `descriptor` carries the persisted
 * shape — rates as strings, the current descriptor version — because the row
 * travels the production read, not a hand-built descriptor list.
 */
function row(params: {
  readonly modelId: string;
  readonly inputPerToken: string;
  readonly outputPerToken: string;
  readonly releasedAtMs: number;
  readonly adminDisabled?: boolean;
}): Record<string, unknown> {
  return {
    id: `catalog-${params.modelId}`,
    modelId: params.modelId,
    descriptor: {
      id: params.modelId,
      provider: 'vendor',
      version: '3',
      inputs: ['text'],
      outputs: ['text'],
      parameters: {},
      behaviors: ['streaming'],
      limits: { contextLength: 128_000, maxOutputTokens: 8000 },
      pricing: {
        kind: 'tokens',
        anchor: { base: { input: params.inputPerToken, output: params.outputPerToken }, tiers: [] },
      },
      zdrReachable: true,
      releasedAt: Math.floor(params.releasedAtMs / 1000),
      fetchedAt: 0,
    },
    adminDisabledAt: params.adminDisabled === true ? new Date(TEST_DAY_START) : null,
    excludedReason: null,
    popularityRank: null,
    lastSeenAt: new Date(),
  };
}

/** A spread of dear models, so a cheap row sits below the premium price quartile. */
function priceSpread(): Record<string, unknown>[] {
  return [100n, 200n, 300n].map((rate, index) =>
    row({
      modelId: `gated/spread-${String(index)}`,
      inputPerToken: String(rate),
      outputPerToken: String(rate),
      releasedAtMs: TEST_DAY_START - 4000 * HOUR_MS,
    })
  );
}

/** Cheap and long-released: below the price quartile and outside the recency window. */
function cheapRow(): Record<string, unknown> {
  return row({
    modelId: CHEAP_MODEL,
    inputPerToken: '1',
    outputPerToken: '1',
    releasedAtMs: RELEASED_OUTSIDE_RECENCY_WINDOW_MS,
  });
}

/** The SAME id, released at the reference instant — premium on the recency leg. */
function cheapRowReleasedNow(): Record<string, unknown> {
  return row({
    modelId: CHEAP_MODEL,
    inputPerToken: '1',
    outputPerToken: '1',
    releasedAtMs: NOW.getTime(),
  });
}

interface CatalogDb {
  readonly db: Database;
  reads: () => number;
}

/**
 * A database whose whole-table catalog read serves the given snapshots in
 * order, the last one repeating. Serving a DIFFERENT snapshot to a second read
 * is what makes a test able to tell one read from two: an outcome that depends
 * on which snapshot answered names the read that produced it.
 */
function catalogDb(...snapshots: readonly (readonly Record<string, unknown>[])[]): CatalogDb {
  let reads = 0;
  const db = {
    select: () => ({
      from: () => {
        const snapshot = snapshots[Math.min(reads, snapshots.length - 1)] ?? [];
        reads += 1;
        return Promise.resolve(snapshot);
      },
    }),
  } as unknown as Database;
  return { db, reads: () => reads };
}

interface StoreStubs {
  readonly privilege?: string;
  /** The caller's purchased balance; `0n` leaves them unable to access premium. */
  readonly purchasedBalanceNanoUsd?: bigint;
}

function stores(stubs: StoreStubs = {}): {
  conversations: ConversationsStoresFactory;
  billing: BillingStores;
} {
  const conversations = (() => ({
    members: {
      activeByUser: () => okAsync({ id: 'm1', privilege: stubs.privilege ?? 'write' }),
      activeLinkGuest: () => okAsync(null),
    },
    conversations: {
      get: () => okAsync({ currentEpoch: 3, ownerUserId: 'u1', conversationBudgetNanoUsd: 0n }),
    },
    forks: { byId: () => okAsync(null) },
    epochs: { conversationsWithDepartedHolders: () => okAsync(new Set<string>()) },
  })) as unknown as ConversationsStoresFactory;
  const billing = {
    readWallets: () =>
      okAsync([
        { id: 'free-w', type: 'free', balanceNanoUsd: 0n },
        {
          id: 'paid-w',
          type: 'purchased',
          balanceNanoUsd: stubs.purchasedBalanceNanoUsd ?? 0n,
        },
      ]),
    readMemberBudget: () => okAsync(null),
    readConversationSpent: () => okAsync(0n),
    readAllowanceSpent: () => okAsync(0n),
  } as unknown as BillingStores;
  return { conversations, billing };
}

function deps(catalog: CatalogDb, stubs: StoreStubs = {}): GatedTurnContextDeps {
  return { db: catalog.db, telemetry: silentTelemetry, ...stores(stubs) };
}

function bodyPinning(...ids: readonly string[]): GatedTurnRequest {
  return { conversationId: 'c1', turnSources: ids.map((id) => ({ kind: 'model', id })) };
}

const SENDER = { kind: 'user', userId: 'u1' } as const;

function caller(premiumTierGate: PremiumTierGateMode = 'enforced'): GatedTurnCaller {
  return { sender: SENDER, premiumTierGate, promptCharacterCount: 400, inputCharacterCount: 100 };
}

describe('the gated turn context applies the gates in domain, in one order', () => {
  it('resolves the context for a permitted caller on a clean selection', async () => {
    const catalog = catalogDb([cheapRow(), ...priceSpread()]);
    const outcome = await gatedTurnContext(deps(catalog), bodyPinning(CHEAP_MODEL), caller(), NOW);
    const value = outcome._unsafeUnwrap();
    expect(value.kind).toBe('resolved');
    if (value.kind !== 'resolved') throw new Error('expected a resolved context');
    expect(value.context.epochNumber).toBe(3);
    expect(value.context.walletId).toBe('free-w');
  });

  it('refuses that same turn when the ONLY snapshot classifies the model premium', async () => {
    // The premise the single-read test rests on, asserted rather than assumed:
    // the later snapshot genuinely flips the answer, so a second read would be
    // visible in the outcome and not only in a call count.
    const catalog = catalogDb([cheapRowReleasedNow()]);
    const outcome = await gatedTurnContext(deps(catalog), bodyPinning(CHEAP_MODEL), caller(), NOW);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'refused', refusal: 'tier-locked' });
  });

  it('reads the catalog ONCE, so one snapshot prices the freeze and classifies the tier', async () => {
    // The first snapshot carries the model as cheap and long-released; the
    // second carries the same id released at the reference instant, which is
    // premium on the recency leg. A second read would therefore answer
    // tier-locked for a caller who cannot access premium.
    const catalog = catalogDb([cheapRow(), ...priceSpread()], [cheapRowReleasedNow()]);
    const outcome = await gatedTurnContext(deps(catalog), bodyPinning(CHEAP_MODEL), caller(), NOW);
    expect(outcome._unsafeUnwrap().kind).toBe('resolved');
    expect(catalog.reads()).toBe(1);
  });

  it('refuses a premium selection a self-funding caller with no balance cannot access', async () => {
    const catalog = catalogDb([
      row({
        modelId: PREMIUM_MODEL,
        inputPerToken: '1',
        outputPerToken: '1',
        releasedAtMs: NOW.getTime(),
      }),
      ...priceSpread(),
    ]);
    const outcome = await gatedTurnContext(
      deps(catalog),
      bodyPinning(PREMIUM_MODEL),
      caller(),
      NOW
    );
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'refused', refusal: 'tier-locked' });
  });

  it('names the DISABLED model rather than the tier when a selection carries both', async () => {
    // Availability before entitlement: the caller is tier-gated on the premium
    // model, and still owes the specific kill-switch refusal.
    const catalog = catalogDb([
      row({
        modelId: DISABLED_MODEL,
        inputPerToken: '1',
        outputPerToken: '1',
        releasedAtMs: RELEASED_OUTSIDE_RECENCY_WINDOW_MS,
        adminDisabled: true,
      }),
      row({
        modelId: PREMIUM_MODEL,
        inputPerToken: '1',
        outputPerToken: '1',
        releasedAtMs: NOW.getTime(),
      }),
      ...priceSpread(),
    ]);
    const outcome = await gatedTurnContext(
      deps(catalog),
      bodyPinning(DISABLED_MODEL, PREMIUM_MODEL),
      caller(),
      NOW
    );
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'refused', refusal: 'model-disabled' });
  });

  it('names the PRIVILEGE rather than the model when a read-only member selects a disabled one', async () => {
    // Authorization before availability: a member who may never spend is
    // refused on that, whatever their selection happens to carry.
    const catalog = catalogDb([
      row({
        modelId: DISABLED_MODEL,
        inputPerToken: '1',
        outputPerToken: '1',
        releasedAtMs: RELEASED_OUTSIDE_RECENCY_WINDOW_MS,
        adminDisabled: true,
      }),
      ...priceSpread(),
    ]);
    const outcome = await gatedTurnContext(
      deps(catalog, { privilege: 'read' }),
      bodyPinning(DISABLED_MODEL),
      caller(),
      NOW
    );
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'refused', refusal: 'send-forbidden' });
  });

  it('exempts the re-run of an already-chosen model from the tier gate', async () => {
    const catalog = catalogDb([
      row({
        modelId: PREMIUM_MODEL,
        inputPerToken: '1',
        outputPerToken: '1',
        releasedAtMs: NOW.getTime(),
      }),
      ...priceSpread(),
    ]);
    const outcome = await gatedTurnContext(
      deps(catalog),
      bodyPinning(PREMIUM_MODEL),
      caller('exemptModelAlreadyChosen'),
      NOW
    );
    expect(outcome._unsafeUnwrap().kind).toBe('resolved');
  });

  it('still applies the kill switch to an exempt re-run — availability is not entitlement', async () => {
    const catalog = catalogDb([
      row({
        modelId: DISABLED_MODEL,
        inputPerToken: '1',
        outputPerToken: '1',
        releasedAtMs: RELEASED_OUTSIDE_RECENCY_WINDOW_MS,
        adminDisabled: true,
      }),
      ...priceSpread(),
    ]);
    const outcome = await gatedTurnContext(
      deps(catalog),
      bodyPinning(DISABLED_MODEL),
      caller('exemptModelAlreadyChosen'),
      NOW
    );
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'refused', refusal: 'model-disabled' });
  });

  it('carries a failed catalog read out as the typed error, never as a refusal', async () => {
    const failing = {
      db: {
        select: () => ({ from: () => Promise.reject(new Error('catalog unreachable')) }),
      } as unknown as Database,
      reads: () => 0,
    };
    const outcome = await gatedTurnContext(deps(failing), bodyPinning(CHEAP_MODEL), caller(), NOW);
    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('lets a caller with a purchased balance run the premium model', async () => {
    const catalog = catalogDb([
      row({
        modelId: PREMIUM_MODEL,
        inputPerToken: '1',
        outputPerToken: '1',
        releasedAtMs: NOW.getTime(),
      }),
      ...priceSpread(),
    ]);
    const outcome = await gatedTurnContext(
      deps(catalog, { purchasedBalanceNanoUsd: 1_000_000_000n }),
      bodyPinning(PREMIUM_MODEL),
      caller(),
      NOW
    );
    expect(outcome._unsafeUnwrap().kind).toBe('resolved');
  });
});

describe('the regenerate tier-gate mode tests the exemption premise', () => {
  const ANCHOR = 'anchor-1';
  const REPLY = 'reply-1';
  const SIBLING = 'reply-2';

  /**
   * A conversations store whose only read is the reply-model list. Passing a
   * store with nothing else on it is the assertion that the decider reads one
   * thing: any other access throws rather than resolving.
   */
  function replyStores(
    rows: readonly { readonly messageId: string; readonly modelId: string }[]
  ): ConversationsStores {
    return {
      messages: { assistantReplyModels: () => okAsync(rows) },
    } as unknown as ConversationsStores;
  }

  function request(overrides: {
    readonly pinned: readonly string[];
    readonly replaceAssistantId?: string;
  }): RegenerateTierGateRequest {
    return {
      conversationId: 'c1',
      targetMessageId: ANCHOR,
      turnSources: overrides.pinned.map((id) => ({ kind: 'model', id })),
      ...(overrides.replaceAssistantId === undefined
        ? {}
        : { replaceAssistantId: overrides.replaceAssistantId }),
    };
  }

  it('exempts a re-run of the model the replaced reply already used', async () => {
    const mode = await regenerateTierGateMode(
      replyStores([{ messageId: REPLY, modelId: CHEAP_MODEL }]),
      request({ pinned: [CHEAP_MODEL] })
    );
    expect(mode._unsafeUnwrap()).toBe('exemptModelAlreadyChosen');
  });

  it('enforces the gate when the caller substitutes a model the replies never used', async () => {
    const mode = await regenerateTierGateMode(
      replyStores([{ messageId: REPLY, modelId: CHEAP_MODEL }]),
      request({ pinned: [PREMIUM_MODEL] })
    );
    expect(mode._unsafeUnwrap()).toBe('enforced');
  });

  it('enforces the gate when only some of the pinned models were already chosen', async () => {
    const mode = await regenerateTierGateMode(
      replyStores([{ messageId: REPLY, modelId: CHEAP_MODEL }]),
      request({ pinned: [CHEAP_MODEL, PREMIUM_MODEL] })
    );
    expect(mode._unsafeUnwrap()).toBe('enforced');
  });

  it("judges a retry-one against the reply it names rather than that reply's siblings", async () => {
    // The sibling's model was chosen for the sibling, not for the reply being
    // replaced, so it is a fresh entitlement decision.
    const mode = await regenerateTierGateMode(
      replyStores([
        { messageId: REPLY, modelId: CHEAP_MODEL },
        { messageId: SIBLING, modelId: PREMIUM_MODEL },
      ]),
      request({ pinned: [PREMIUM_MODEL], replaceAssistantId: REPLY })
    );
    expect(mode._unsafeUnwrap()).toBe('enforced');
  });

  it('exempts a retry-one re-running the model of the reply it names', async () => {
    const mode = await regenerateTierGateMode(
      replyStores([
        { messageId: REPLY, modelId: CHEAP_MODEL },
        { messageId: SIBLING, modelId: PREMIUM_MODEL },
      ]),
      request({ pinned: [CHEAP_MODEL], replaceAssistantId: REPLY })
    );
    expect(mode._unsafeUnwrap()).toBe('exemptModelAlreadyChosen');
  });

  it('enforces the gate on an anchor with no reply to replace', async () => {
    const mode = await regenerateTierGateMode(replyStores([]), request({ pinned: [CHEAP_MODEL] }));
    expect(mode._unsafeUnwrap()).toBe('enforced');
  });

  it('carries a failed reply-model read out as the typed error, never as a mode', async () => {
    const failing = {
      messages: { assistantReplyModels: () => errAsync(unavailableError('reply models down')) },
    } as unknown as ConversationsStores;
    const mode = await regenerateTierGateMode(failing, request({ pinned: [CHEAP_MODEL] }));
    expect(mode._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('the member privilege gate answers one rule for both gated routes', () => {
  const USER: ConversationCaller = { kind: 'user', userId: 'u1' };
  const GUEST: ConversationCaller = { kind: 'linkGuest', linkId: 'l1', conversationId: 'c1' };

  /**
   * Every combination of the three inputs, each verdict written literally: a
   * verdict derived from the rule would move with the rule and pin nothing.
   */
  const TABLE: readonly {
    readonly privilege: MemberPrivilege | null;
    readonly action: GatedCallerAction;
    readonly caller: ConversationCaller;
    readonly admits: boolean;
  }[] = [
    { privilege: null, action: 'send', caller: USER, admits: false },
    { privilege: null, action: 'send', caller: GUEST, admits: false },
    { privilege: null, action: 'runControl', caller: USER, admits: false },
    { privilege: null, action: 'runControl', caller: GUEST, admits: false },
    { privilege: 'read', action: 'send', caller: USER, admits: false },
    { privilege: 'read', action: 'send', caller: GUEST, admits: false },
    { privilege: 'read', action: 'runControl', caller: USER, admits: true },
    { privilege: 'read', action: 'runControl', caller: GUEST, admits: false },
    { privilege: 'write', action: 'send', caller: USER, admits: true },
    { privilege: 'write', action: 'send', caller: GUEST, admits: true },
    { privilege: 'write', action: 'runControl', caller: USER, admits: true },
    { privilege: 'write', action: 'runControl', caller: GUEST, admits: true },
    { privilege: 'admin', action: 'send', caller: USER, admits: true },
    { privilege: 'admin', action: 'send', caller: GUEST, admits: true },
    { privilege: 'admin', action: 'runControl', caller: USER, admits: true },
    { privilege: 'admin', action: 'runControl', caller: GUEST, admits: true },
    { privilege: 'owner', action: 'send', caller: USER, admits: true },
    { privilege: 'owner', action: 'send', caller: GUEST, admits: true },
    { privilege: 'owner', action: 'runControl', caller: USER, admits: true },
    { privilege: 'owner', action: 'runControl', caller: GUEST, admits: true },
  ];

  it.each(TABLE)(
    'answers $admits for a $privilege member doing $action as a $caller.kind',
    ({ privilege, action, caller, admits }) => {
      const member = privilege === null ? null : { privilege };
      expect(memberAdmits(action, caller, member)).toBe(admits);
    }
  );
});
