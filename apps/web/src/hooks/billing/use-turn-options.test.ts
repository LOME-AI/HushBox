/**
 * The token adapter hook: the single place `apps/web` calls the money layer's
 * token producer. Everything these tests assert is about the ADAPTER — what it
 * feeds the producer and how it behaves while its inputs load. The verdicts
 * themselves belong to the producer and are pinned in `packages/shared`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SMART_MODEL_ID, modelSchema } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import {
  useTurnOptions,
  usePickerOptions,
  CATALOG_INSTANT_MS,
} from '@/hooks/billing/use-turn-options';
import type { Model, PromptBasis, UserTier } from '@hushbox/shared';
import type { UseTurnOptionsResult } from '@/hooks/billing/use-turn-options';
import type { RenderHookResult } from '@testing-library/react';

const mockSpendableCalls: (string | null)[] = [];

const { mockFundingRead, mockTierInfo, mockModelsData, mockSelection, mockModality } = vi.hoisted(
  () => ({
    mockFundingRead: { current: undefined as unknown },
    mockTierInfo: { current: { tier: 'paid' } as { tier: UserTier } },
    mockModelsData: { current: undefined as unknown },
    mockSelection: { current: [] as { id: string; name: string }[] },
    mockModality: { current: 'text' as string },
    mockOwnWallet: { current: undefined as unknown },
    mockBudgets: { current: { data: undefined, isPending: false } as unknown },
  })
);

// Argument-aware, matching the pattern the prompt-budget suite already uses:
// `mockOwnWallet` defaults to `undefined`, meaning both arms share one fixture.
// ONE read now: the conversation names the payer and the server resolves it.
// The argument is recorded so payer-scoping is observable rather than assumed.
//
// A double, not a second implementation: each test states what is KNOWN about
// the payer's funding — served, awaiting, exhausted, or no door at all. How a
// query settles into that answer is pinned where it lives, in
// `use-spendable.test.ts`.
vi.mock('@/hooks/billing/use-spendable', () => ({
  useFundingRead: (_isAuthenticated: boolean, conversationId: string | null) => {
    mockSpendableCalls.push(conversationId);
    return mockFundingRead.current;
  },
}));
vi.mock('@/hooks/billing/use-user-tier-info', () => ({
  useUserTierInfo: () => mockTierInfo.current,
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: mockModelsData.current }),
}));
vi.mock('@/hooks/chat/use-web-search', () => ({
  useWebSearch: () => ({ active: false }),
}));
vi.mock('@/stores/model', () => ({
  useModelStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeModality: mockModality.current,
      selections: { [mockModality.current]: mockSelection.current },
    }),
}));

const BASIS: PromptBasis = {
  systemChars: 400,
  instructionChars: 0,
  historyChars: 200,
  inputChars: 50,
  attachmentBytes: 0,
};

function wireModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    name: overrides.id,
    provider: 'Test',
    modality: 'text',
    contextLength: 128_000,
    maxOutputTokens: 8000,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
    description: 'A test model',
    supportedParameters: [],
    created: OLD_RELEASE_SECONDS,
    ...overrides,
  };
}

function served(spendableNanoUsd: string, payer: 'self' | 'owner' = 'self'): unknown {
  return {
    status: 'served',
    snapshot: { spendableNanoUsd, heldNanoUsd: '0', payerTier: 'paid', payer },
  };
}

/** A door-holder whose read is exhausted: it settled, and it settled with nothing. */
const UNAVAILABLE = { status: 'unavailable', snapshot: undefined };
/** A door-holder whose read can still land. */
const AWAITING = { status: 'awaiting', snapshot: undefined };
/** The trial: no funding door at all, so its absence is permanent and gates nothing. */
const NO_DOOR = { status: 'no-door', snapshot: undefined };

beforeEach(() => {
  mockSpendableCalls.length = 0;
  mockFundingRead.current = served('100000000000');
  mockTierInfo.current = { tier: 'paid' };
  mockModelsData.current = { models: [wireModel({ id: 'vendor/a' })], premiumIds: new Set() };
  mockSelection.current = [{ id: 'vendor/a', name: 'vendor/a' }];
  mockModality.current = 'text';
});

describe('useTurnOptions — the produced pair', () => {
  it('produces both sets for a funded text turn', () => {
    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(false);
    expect(result.current.options?.affordable.sendable).toBe(true);
    expect(result.current.options?.admissible.sendable).toBe(true);
  });

  it('maps the Smart Model sentinel onto the smart slot, never a catalog id', () => {
    // The sentinel is not a catalog row, so passing it through as a pinned
    // model id would mark the turn unpriceable instead of opening the model
    // axis. Two models plus the sentinel is the hardest shape the picker
    // supports, so it is the one worth pinning.
    mockModelsData.current = {
      models: [wireModel({ id: 'vendor/a' }), wireModel({ id: 'vendor/b' })],
      premiumIds: new Set(),
    };
    mockSelection.current = [
      { id: 'vendor/a', name: 'a' },
      { id: SMART_MODEL_ID, name: 'Smart' },
    ];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    const all = result.current.options?.affordable.all ?? [];
    expect(all.some((entry) => entry.modelId === SMART_MODEL_ID)).toBe(false);
    expect(all.find((entry) => entry.modelId === 'vendor/a')?.kind).toBe('pinned');
    expect(all.find((entry) => entry.modelId === 'vendor/b')?.kind).toBe('candidate');
  });
});

describe('useTurnOptions — premium rows are marked, never removed', () => {
  /**
   * A spread of cheap models plus one far dearer. The prices are DISTINCT and
   * ascending so the 75th-percentile threshold lands strictly above the model
   * the turn pins — a flat cheap tier puts the percentile on the tier itself
   * and classifies the whole catalog premium, which would make this fixture
   * prove the opposite of what it claims.
   */
  function catalogWithPremiumTail(): Model[] {
    const cheap = [1000, 2000, 3000, 4000].map((rate) =>
      wireModel({
        id: `vendor/cheap-${String(rate)}`,
        pricing: { inputPerToken: String(rate), outputPerToken: String(rate) },
      })
    );
    return [
      ...cheap,
      wireModel({
        id: 'vendor/premium',
        pricing: { inputPerToken: '900000', outputPerToken: '1800000' },
      }),
    ];
  }

  it('keeps a premium row PRESENT and marked while the composer stays sendable', () => {
    mockTierInfo.current = { tier: 'free' };
    mockFundingRead.current = {
      status: 'served',
      snapshot: {
        spendableNanoUsd: '50000000',
        heldNanoUsd: '0',
        payerTier: 'free',
        payer: 'self',
      },
    };
    mockModelsData.current = { models: catalogWithPremiumTail(), premiumIds: new Set() };
    mockSelection.current = [{ id: 'vendor/cheap-1000', name: 'cheap' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    const all = result.current.options?.affordable.all ?? [];
    const premium = all.find((entry) => entry.modelId === 'vendor/premium');

    // Present, not filtered out of the list.
    expect(premium).toBeDefined();
    // Marked, with the reason that names an action this payer can take.
    expect(premium?.availability).toEqual({
      available: false,
      reason: 'premium_requires_credit',
    });
    // And the turn still sends, because a different model answers it.
    expect(result.current.options?.admissible.sendable).toBe(true);
  });

  it('names the account reason, not the credit reason, for a payer with no account', () => {
    // Two premium reasons exist because their ACTIONS differ: sign up versus
    // add credit. Collapsing them would offer a payment path to someone with
    // no account.
    mockTierInfo.current = { tier: 'trial' };
    // The trial is the one tier with no funding door, which is why its snapshot
    // is permanently absent rather than merely unresolved.
    mockFundingRead.current = NO_DOOR;
    mockModelsData.current = { models: catalogWithPremiumTail(), premiumIds: new Set() };
    mockSelection.current = [{ id: 'vendor/cheap-1000', name: 'cheap' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: false }));

    const all = result.current.options?.affordable.all ?? [];
    expect(all.find((entry) => entry.modelId === 'vendor/premium')?.availability).toEqual({
      available: false,
      reason: 'premium_requires_account',
    });
  });
});

describe('useTurnOptions — the loading window', () => {
  it('reports pending and produces NO verdict while the funding read is in flight', () => {
    // The served figure is absent mid-flight. Treating that absence as 0n is
    // how every affordable row greys for a render; the adapter must withhold
    // the verdict instead of manufacturing a poor one.
    mockFundingRead.current = AWAITING;

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(true);
    expect(result.current.options).toBeUndefined();
  });

  it('reports pending while the catalog is in flight', () => {
    mockModelsData.current = undefined;

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(true);
    expect(result.current.options).toBeUndefined();
  });

  it('produces a verdict for a trial payer, which has no funding door to wait on', () => {
    // A caller with no door never resolves the read, so a permanently pending
    // query must not gate it — its ceiling is client-side. A link guest DOES
    // have a door and IS gated; that half is pinned in the guest describe.
    mockFundingRead.current = NO_DOOR;
    mockTierInfo.current = { tier: 'trial' };

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: false }));

    expect(result.current.isPending).toBe(false);
    expect(result.current.options).toBeDefined();
  });

  it('reports an exhausted funding read as unavailable rather than as still pending', () => {
    // The distinction the surfaces need: a pending read resolves itself, an
    // exhausted one never does, so reporting the second as pending is the
    // indefinite silent wait. No verdict is produced either way.
    mockFundingRead.current = UNAVAILABLE;

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isFundingUnavailable).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.options).toBeUndefined();
  });

  it('claims no funding failure while a read is merely in flight', () => {
    mockFundingRead.current = AWAITING;

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isFundingUnavailable).toBe(false);
  });
});

describe('useTurnOptions — the served-value contract for the instant', () => {
  it('reads no clock while rendering — the instant is captured once, at module load', () => {
    // The discriminating input: swapping `CATALOG_INSTANT_MS` for a per-render
    // `Date.now()` makes this spy fire. Asserting the exported constant equals
    // itself would pass under that change, so it is the CALL that is pinned.
    const clock = vi.spyOn(Date, 'now');

    const { rerender } = renderHook(
      (basis: PromptBasis) => useTurnOptions({ basis, isAuthenticated: true }),
      { initialProps: BASIS }
    );
    rerender({ ...BASIS, inputChars: BASIS.inputChars + 25 });
    rerender({ ...BASIS, inputChars: BASIS.inputChars + 50 });

    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it('feeds the producer one instant, so both sets classify premium identically', () => {
    // Two calls a second apart must not be able to disagree about recency.
    // The adapter owns this: it passes ONE snapshot, and the producer uses it
    // for both passes.
    const first = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    vi.setSystemTime(new Date(CATALOG_INSTANT_MS + 60_000));
    const second = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(first.result.current.options?.affordable).toStrictEqual(
      second.result.current.options?.affordable
    );
    vi.useRealTimers();
  });
});

describe('useTurnOptions — the payer the SERVER named', () => {
  /**
   * The client no longer decides who pays. `GET /billing/spendable` takes the
   * conversation, applies §Group Funding 2 server-side, and returns the winning
   * wallet's figures plus `payer` and `tier`. Re-resolving that here was a
   * second authority for a decision the wire already carries — and it
   * disagreed with the server inside the settle-then-release window.
   *
   * The fixture that motivated the old client-side resolution was
   * unreachable: the owner arm only returns when hold-blind headroom is
   * positive, so `{spendable: 0, held: 0, payer: 'owner'}` cannot be served.
   */
  function render(): RenderHookResult<UseTurnOptionsResult, unknown> {
    return renderHook(() =>
      useTurnOptions({ basis: BASIS, isAuthenticated: true, conversationId: 'conv-1' })
    );
  }

  it('prices an owner-funded turn from the served owner figures', () => {
    mockFundingRead.current = served('100000000000', 'owner');

    expect(render().result.current.options?.affordable.all[0]?.availability).toEqual({
      available: true,
    });
  });

  it('greys when the served figure — whoever it describes — cannot fund the floor', () => {
    // Labelled `self`: the owner arm is only returned when hold-blind headroom
    // is positive, so a zero figure with nothing held cannot describe an owner.
    // The assertion is about the FIGURE, not the label.
    mockFundingRead.current = served('0', 'self');

    expect(render().result.current.options?.affordable.all[0]?.availability).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('stays hold-blind for greying: a held-out group budget does not grey a row', () => {
    // `affordable` reconstructs `spendable + held`, so a hold cannot grey.
    // This is the one group property that is genuinely the CLIENT's, and it is
    // structural rather than a second resolution.
    mockFundingRead.current = {
      status: 'served',
      snapshot: {
        spendableNanoUsd: '0',
        heldNanoUsd: '100000000000',
        tier: 'paid',
        payer: 'owner',
      },
    };

    expect(render().result.current.options?.affordable.all[0]?.availability).toEqual({
      available: true,
    });
  });

  it('asks the endpoint for the conversation that names the payer', () => {
    mockFundingRead.current = served('100000000000', 'owner');
    render();
    // A conversation-blind read would serve the SENDER's wallet and tier.
    expect(mockSpendableCalls).toContain('conv-1');
  });
});

describe('the send gate refuses exactly the admissible ⊂ affordable difference', () => {
  /**
   * THE case the two-set design exists for. Both sets are produced from one
   * call; the difference between them is a HOLD, never poverty, so the picker
   * must stay normal while the send is blocked with a wait-for-it reason
   * (BILLING §Notices 9, §Affordability — the four notions).
   */
  it('holds funds out: affordable sendable, admissible not — a strict subset', () => {
    // Effective balance = spendable + held = 0 + 100e9, so the model is
    // affordable; spendable alone is 0, so nothing can START right now.
    mockFundingRead.current = {
      status: 'served',
      snapshot: {
        spendableNanoUsd: '0',
        heldNanoUsd: '100000000000',
        tier: 'paid',
        payer: 'self',
      },
    };

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    const options = result.current.options;

    // affordable: the payer CAN call this model — hold-blind.
    expect(options?.affordable.sendable).toBe(true);
    expect(options?.affordable.all[0]?.availability).toEqual({ available: true });

    // admissible: strictly smaller — the turn cannot start this instant.
    expect(options?.admissible.sendable).toBe(false);

    // And the hold is the only difference: no row is greyed for money.
    expect(options?.affordable.all.every((row) => row.availability.available)).toBe(true);
  });

  it('genuine poverty puts the selection outside BOTH sets', () => {
    // The contrast case: nothing held, no funds. `affordable` refuses too, so
    // the picker greys and the reason is money rather than waiting.
    mockFundingRead.current = served('0');

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.options?.affordable.sendable).toBe(false);
    expect(result.current.options?.admissible.sendable).toBe(false);
    expect(result.current.options?.affordable.all[0]?.availability).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });
});

describe('a smart-slot-only turn with no contributing model', () => {
  /**
   * DECIDED, not left implicit: when the candidate pool is empty the producer
   * contributes NO turn-level rungs, so the effort strip has nothing to grade
   * and renders Auto alone (Auto is always selectable — it delegates the
   * choice; §Reasoning Effort 5). The per-row lists are unaffected because
   * there are no rows either — this is not the "rows render but the strip is
   * blank" asymmetry, which the both-arms rule already removed: an UNSENDABLE
   * turn that still has a candidate keeps every rung, marked.
   */
  it('yields an empty dimension list rather than an ungraded one', () => {
    mockSelection.current = [{ id: SMART_MODEL_ID, name: 'Smart' }];
    mockModelsData.current = { models: [], premiumIds: new Set() };

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    const options = result.current.options;

    expect(options?.affordable.sendable).toBe(false);
    expect(options?.affordable.turnDimensions).toEqual([]);
    // No rows either — the strip and the list agree because both are empty.
    expect(options?.affordable.all).toEqual([]);
  });

  it('keeps every rung MARKED when a candidate exists but cannot be funded', () => {
    // The contrast that shows the empty case above is about an empty POOL, not
    // about unsendability. Here the turn is equally unsendable, yet the strip
    // is fully populated and greyed — greyed-never-hidden.
    mockSelection.current = [{ id: SMART_MODEL_ID, name: 'Smart' }];
    mockModelsData.current = {
      models: [wireModel({ id: 'vendor/a', reasoning: { supportedEfforts: ['low', 'high'] } })],
      premiumIds: new Set(),
    };
    mockFundingRead.current = served('0');

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    const dimension = result.current.options?.affordable.turnDimensions[0];

    expect(result.current.options?.affordable.sendable).toBe(false);
    expect(dimension?.options.length).toBeGreaterThan(0);
    expect(dimension?.options.every((option) => !option.availability.available)).toBe(true);
  });
});

describe('the trial — the one tier with no funding door', () => {
  /**
   * §Affordability 8 fixes the TRIAL at a $0.01 effective balance because it
   * has no funding endpoint to read; `served` is permanently undefined for it,
   * and handing the producer `0n` instead reads as poverty and refuses the
   * entire trial funnel while the server admits those turns on quota. A link
   * guest is not here — it has a door of its own (see the guest describe).
   */
  it('sends on the fixed per-message ceiling rather than refusing as broke', () => {
    mockFundingRead.current = NO_DOOR;
    mockTierInfo.current = { tier: 'trial' };
    mockModelsData.current = {
      models: [
        wireModel({
          id: 'vendor/cheap',
          pricing: { inputPerToken: '1000', outputPerToken: '2000' },
        }),
      ],
      premiumIds: new Set(),
    };
    mockSelection.current = [{ id: 'vendor/cheap', name: 'cheap' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: false }));

    expect(result.current.options?.affordable.all[0]?.availability).toEqual({ available: true });
    expect(result.current.options?.admissible.sendable).toBe(true);
  });
});

describe('the link guest — owner-funded, never trial-capped', () => {
  /**
   * A guest HAS a funding door: its read serves the payer's snapshot. So every
   * funding-derived property of its turn is the payer's — the ceiling it sizes
   * against, the tier that prices it, and the premium access that follows
   * (BILLING §Group Funding 1, §User Tiers).
   */
  function guestOn(models: Model[], selection: string): void {
    mockTierInfo.current = { tier: 'guest' };
    mockModelsData.current = { models, premiumIds: new Set(['vendor/premium']) };
    mockSelection.current = [{ id: selection, name: selection }];
  }

  it("sizes the guest's turn from the payer's served figure, not the trial ceiling", () => {
    // $9 served would buy far more than the 1¢ trial ceiling ever could, so a
    // ceiling this large is only reachable through the served figure.
    // A wide output cap so MONEY is the binding term rather than capability:
    // that is what makes the ceiling discriminate between the served figure and
    // the 1¢ trial ceiling, which buys roughly eight thousand tokens here.
    guestOn(
      [
        wireModel({
          id: 'vendor/cheap',
          maxOutputTokens: 5_000_000,
          pricing: { inputPerToken: '1', outputPerToken: '1' },
        }),
      ],
      'vendor/cheap'
    );
    mockFundingRead.current = {
      status: 'served',
      snapshot: {
        spendableNanoUsd: '9000000000',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'owner',
      },
    };

    const { result } = renderHook(() =>
      useTurnOptions({ basis: BASIS, isAuthenticated: false, conversationId: 'conv-1' })
    );

    expect(result.current.payer).toBe('owner');
    expect(result.current.payerSpendableNanoUsd).toBe(9_000_000_000n);
    const ceiling = result.current.options?.admissible.all[0]?.ceilingTokens ?? 0;
    expect(ceiling).toBeGreaterThan(100_000);
  });

  it("grades premium access on the payer's tier, so an owner-funded guest sees what the owner sees", () => {
    guestOn(
      [wireModel({ id: 'vendor/premium', pricing: { inputPerToken: '1', outputPerToken: '1' } })],
      'vendor/premium'
    );
    mockFundingRead.current = {
      status: 'served',
      snapshot: {
        spendableNanoUsd: '9000000000',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'owner',
      },
    };

    const { result } = renderHook(() =>
      useTurnOptions({ basis: BASIS, isAuthenticated: false, conversationId: 'conv-1' })
    );

    expect(result.current.options?.affordable.all[0]?.availability).toEqual({ available: true });
  });

  it('says the guest funding read is unavailable rather than sizing on the trial ceiling', () => {
    // An exhausted read is not a pending one, and neither may reach the trial
    // ceiling: a guest has a door of its own, so falling through to the $0.01
    // ceiling is exactly the tier conflation that door exists to keep it off.
    guestOn(
      [
        wireModel({
          id: 'vendor/cheap',
          maxOutputTokens: 5_000_000,
          pricing: { inputPerToken: '1', outputPerToken: '1' },
        }),
      ],
      'vendor/cheap'
    );
    mockFundingRead.current = UNAVAILABLE;

    const { result } = renderHook(() =>
      useTurnOptions({ basis: BASIS, isAuthenticated: false, conversationId: 'conv-1' })
    );

    expect(result.current.isFundingUnavailable).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.options).toBeUndefined();
  });

  it('withholds the verdict while the guest funding read is in flight', () => {
    // The trial ceiling must never stand in for a figure that is merely still
    // loading — that fabrication is what refused the guest composer outright.
    guestOn(
      [wireModel({ id: 'vendor/cheap', pricing: { inputPerToken: '1', outputPerToken: '1' } })],
      'vendor/cheap'
    );
    mockFundingRead.current = AWAITING;

    const { result } = renderHook(() =>
      useTurnOptions({ basis: BASIS, isAuthenticated: false, conversationId: 'conv-1' })
    );

    expect(result.current.isPending).toBe(true);
    expect(result.current.options).toBeUndefined();
  });
});

describe('poolModelFromWire — the fail-closed guards', () => {
  /**
   * Each guard drops a row from the pool rather than defaulting it. The
   * defaults these refuse are not cosmetic: a zero rate prices a turn as FREE,
   * and a missing release date makes every premium-recency test silently
   * false. A dropped row simply is not a candidate.
   */
  function poolIds(models: Model[]): string[] {
    mockModelsData.current = { models, premiumIds: new Set() };
    mockSelection.current = [{ id: SMART_MODEL_ID, name: 'Smart' }];
    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    return (result.current.options?.affordable.all ?? []).map((row) => String(row.modelId));
  }

  it('excludes the synthetic Smart Model row — it is the slot, not a model', () => {
    const ids = poolIds([
      wireModel({ id: 'vendor/real' }),
      wireModel({ id: 'smart', isSmartModel: true }),
    ]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with no input rate rather than pricing it at zero', () => {
    const ids = poolIds([
      wireModel({ id: 'vendor/real' }),
      wireModel({ id: 'vendor/no-input', pricing: { outputPerToken: '2000' } }),
    ]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with no output rate', () => {
    const ids = poolIds([
      wireModel({ id: 'vendor/real' }),
      wireModel({ id: 'vendor/no-output', pricing: { inputPerToken: '1000' } }),
    ]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with a non-positive context length', () => {
    const noContext = wireModel({ id: 'vendor/no-context', contextLength: 0 });

    // A text row with no context window at all is a row the wire contract
    // refuses; the control differs from it by that override alone.
    expect(
      [wireModel({ id: 'vendor/no-context' }), noContext].map(
        (row) => modelSchema.safeParse(row).success
      )
    ).toEqual([true, false]);

    const ids = poolIds([wireModel({ id: 'vendor/real' }), noContext]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with no release date, so recency cannot silently pass', () => {
    const noCreated = wireModel({ id: 'vendor/undated' });

    // field is optional; this reproduces a row that arrived without it.
    delete (noCreated as { created?: number }).created;

    const ids = poolIds([wireModel({ id: 'vendor/real' }), noCreated]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('keeps a fully-specified row', () => {
    expect(poolIds([wireModel({ id: 'vendor/real' })])).toEqual(['vendor/real']);
  });
});

describe('useTurnOptions — selection edges', () => {
  it('produces no options when nothing can answer the turn', () => {
    // Neither a pinned model nor the smart slot: `Selection` requires at least
    // one answer source, so there is no turn to price rather than an empty one.
    mockSelection.current = [];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(false);
    expect(result.current.options).toBeUndefined();
  });

  it('passes a PINNED effort through to the producer', () => {
    // Auto and undefined both mean "open"; an explicit level is a pin, and the
    // producer grades the turn against it rather than against `e_min`. The pin
    // arrives as an ARGUMENT: a hook that computes turn options must not reach
    // into the effort store for one of its own inputs, or the hook that owns
    // that store cannot consume what this one produces.
    mockModelsData.current = {
      models: [wireModel({ id: 'vendor/a', reasoning: { supportedEfforts: ['low', 'high'] } })],
      premiumIds: new Set(),
    };
    mockSelection.current = [{ id: 'vendor/a', name: 'a' }];

    const { result } = renderHook(() =>
      useTurnOptions({ basis: BASIS, isAuthenticated: true, effort: 'high' })
    );

    // A pinned effort narrows the turn: the row is graded on `high`, which this
    // model's 8000-token cap cannot fund alongside a minimum answer.
    expect(result.current.options?.affordable.all[0]?.availability).toEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
  });
});

describe('usePickerOptions — the read for a surface with no prompt', () => {
  it('serves the affordable set without being handed a basis', () => {
    const { result } = renderHook(() => usePickerOptions({ isAuthenticated: true }));

    expect(result.current.isPending).toBe(false);
    expect(result.current.affordable?.sendable).toBe(true);
  });

  it('serves the smart slot its own verdict, the one row the set holds no entry for', () => {
    mockSelection.current = [{ id: SMART_MODEL_ID, name: 'Smart' }];

    const { result } = renderHook(() => usePickerOptions({ isAuthenticated: true }));

    expect(result.current.smartSlotAvailability).toEqual({ available: true });
  });

  it('agrees with the pair the composer reads, rather than producing a second answer', () => {
    const picker = renderHook(() => usePickerOptions({ isAuthenticated: true }));
    const pair = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(picker.result.current.affordable).toEqual(pair.result.current.options?.affordable);
  });

  it('withholds the set while an input is still in flight, rather than refusing', () => {
    mockFundingRead.current = AWAITING;

    const { result } = renderHook(() => usePickerOptions({ isAuthenticated: true }));

    expect(result.current.isPending).toBe(true);
    expect(result.current.affordable).toBeUndefined();
  });

  /**
   * The fail-closed shape. A basis-less caller has no prompt, so any
   * admissibility it could read here would have been computed from a zero one —
   * strictly more permissive than the send gate, which prices the real prompt
   * against `spendable` alone. There is no field to read it off and none to
   * default: `admissible`, the hold and the whole pair stay behind the caller
   * that has a basis to pass.
   */
  it('exposes no admissibility verdict, so no basis-less caller can gate a send on it', () => {
    const { result } = renderHook(() => usePickerOptions({ isAuthenticated: true }));

    expect(Object.keys(result.current).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'affordable',
      'isPending',
      'smartSlotAvailability',
    ]);
  });
});
