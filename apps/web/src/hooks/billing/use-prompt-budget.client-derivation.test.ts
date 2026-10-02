/**
 * Where the composer's money figures COME FROM: the numbers the server served
 * this client, plus characters this client counted itself. Nothing here asserts
 * that the client and the server agree — agreement is a property of two
 * implementations, and a client that displayed a figure the server had computed
 * for it would satisfy every agreement test ever written while its own
 * arithmetic rotted unobserved.
 *
 * Only the HTTP fetch behind the funding query and the model catalog are
 * stubbed; `useSpendable`, `useFundingRead`, `useBudgetCalculation`,
 * `useTurnOptions` and `usePromptBudget` all run, so each figure asserted below
 * is produced by that chain rather than handed to it. The served snapshot is
 * the whole of what the server contributes: hold-aware spendable, the payer's
 * tier, and the catalog's per-token rates. It carries no token count, no cost
 * and no answer length — the derivation is the client's.
 *
 * The expectations name a character run's token cost through the published
 * counter {@link inputTokensOf} rather than restating the ratio the money layer
 * keeps behind its wall; that ratio is one value for every payer.
 */

import * as React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { charStorageNanoUsd } from '@hushbox/shared';
import { inputTokensOf } from '@hushbox/shared/affordability';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { GetSpendableResponse, Model } from '@hushbox/shared';

/** What the transport serves, and how many times it was asked. */
interface ServedFunding {
  mockSnapshot: { current: GetSpendableResponse };
  mockFundingReads: { count: number };
}

// The return annotation is what binds the snapshot to the wire contract, and it
// is a declared return type rather than `satisfies` because the latter would
// narrow `payerTier` to the literal this fixture happens to open on, which one
// case below deliberately changes.
const { mockSnapshot, mockFundingReads } = vi.hoisted(
  (): ServedFunding => ({
    mockSnapshot: {
      current: {
        spendableNanoUsd: '10500000000',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'self',
        ownerFundingLimit: null,
      },
    },
    mockFundingReads: { count: 0 },
  })
);

// The transport, and the only thing stubbed. `@/lib/api/api` shares the mock
// because it validates the platform env at import; nothing here calls it.
vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/lib/api-client', () => ({
  client: { billing: { spendable: { $get: () => ({}) } } },
  fetchJson: () => {
    mockFundingReads.count += 1;
    return Promise.resolve(mockSnapshot.current);
  },
}));

vi.mock('@/lib/auth/link-guest-auth', () => ({ getLinkGuestAuth: () => null }));

// The SENDER's own tier, held fixed at paid for every case below. It is not the
// payer's: the served snapshot answers that, and one case turns the two against
// each other on purpose.
vi.mock('@/hooks/billing/use-user-tier-info', () => ({
  useUserTierInfo: () => ({
    tier: 'paid' as const,
    purchasedBalanceNanoUsd: 10_000_000_000n,
    freeAllowanceNanoUsd: 0n,
  }),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({ isAuthStable: true, isBalanceStable: true, isAppStable: true }),
}));

vi.mock('@/hooks/billing/use-conversation-budgets', () => ({
  useConversationBudgets: () => ({ data: undefined, isPending: false, isLoading: false }),
}));

// The predicate comes from the real module rather than a second copy here: a
// mock that re-implemented it would agree with production only until one of
// them changed.
vi.mock('@/lib/auth/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth')>();
  return {
    selectInstructionsReadUnresolved: actual.selectInstructionsReadUnresolved,
    useSession: () => ({
      data: { user: { id: 'user-1' }, session: { id: 'session-1' } },
      isPending: false,
    }),
    useAuthStore: (
      selector: (state: {
        customInstructions: string | null;
        customInstructionsStatus: 'pending' | 'absent' | 'present';
        user: { id: string } | null;
      }) => unknown
    ) =>
      selector({
        customInstructions: null,
        customInstructionsStatus: 'absent',
        user: { id: 'user-1' },
      }),
  };
});

vi.mock('@/stores/search', () => ({ useSearchStore: () => ({ webSearchEnabled: false }) }));

/** The served input rate: what one input token costs, in nano-USD. */
const INPUT_RATE_NANO = 10_000n;

const TEXT_MODEL: Model = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'Fictional',
  description: 'Text generation model.',
  modality: 'text',
  supportedParameters: [],
  contextLength: 128_000,
  created: OLD_RELEASE_SECONDS,
  maxOutputTokens: 4096,
  pricing: { inputPerToken: INPUT_RATE_NANO.toString(), outputPerToken: '30000' },
};

vi.mock('@/hooks/models/models', () => ({
  // The return annotation is what binds the row to the wire contract: an
  // unannotated factory infers its own shape, so anything at all typechecks in
  // the catalog position.
  useModels: (): UseModelsStub => ({
    data: { models: [TEXT_MODEL], premiumIds: new Set<string>() },
  }),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  return {
    ...actual,
    useModelStore: (selector?: (state: unknown) => unknown) =>
      selectorFromState(createModelStoreStub())(selector as (s: unknown) => unknown),
  };
});

const TYPED = 'what does this cost';

/** A character run of a stated length — the only thing the client measures. */
function characters(count: number): string {
  return 'x'.repeat(count);
}

/**
 * A character run whose token cost divides exactly, so an expectation can name
 * the tokens it adds without inheriting a rounding boundary from the base
 * count it is added to.
 */
const ADDED_CHARACTERS = 402;

/**
 * One client per render, built OUTSIDE the component so a rerender cannot
 * construct another: the funding-read leg below must rest on the hook not
 * re-reading, never on React Query pinning its client at observer construction.
 * Retries are off so a read settles in one tick; nothing here drives a failing one.
 */
function createWrapper(): ({ children }: { children: React.ReactNode }) => React.ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

/** Render the composer's gate over one composed message, once the snapshot lands. */
async function composerWith(value: string): Promise<ReturnType<typeof usePromptBudget>> {
  const { result } = renderHook(
    () => usePromptBudget({ value, historyCharacters: 0, conversationId: null }),
    { wrapper: createWrapper() }
  );
  await waitFor(() => {
    expect(result.current.fundingSource).toBe('personal_balance');
  });
  return result.current;
}

function serve(snapshot: Partial<GetSpendableResponse>): void {
  mockSnapshot.current = { ...mockSnapshot.current, ...snapshot };
}

describe('the composer figures a payer sees before anything is sent', () => {
  beforeEach(() => {
    mockFundingReads.count = 0;
    mockSnapshot.current = {
      spendableNanoUsd: '10500000000',
      heldNanoUsd: '0',
      payerTier: 'paid',
      payer: 'self',
      ownerFundingLimit: null,
    };
  });

  it('leaves the affordable answer unmoved when the served balance grows by exactly what the added characters cost', async () => {
    // The identity that makes this a derivation rather than an agreement: the
    // two inputs are priced against each other. Characters the hook measured
    // off the composed message are added, and the balance the server served is
    // raised by precisely what those characters cost — the served rate over the
    // tokens they occupy, plus what storing them costs. A client deriving its
    // answer length from both cannot move; one that stopped counting characters
    // would report a LONGER answer for the extra money, and one that ignored
    // the served balance a shorter one for the extra prompt.
    const addedCost =
      BigInt(inputTokensOf(ADDED_CHARACTERS)) * INPUT_RATE_NANO +
      charStorageNanoUsd(ADDED_CHARACTERS);
    const base = await composerWith(TYPED);

    serve({
      spendableNanoUsd: (BigInt(mockSnapshot.current.spendableNanoUsd) + addedCost).toString(),
    });
    const paidFor = await composerWith(TYPED + characters(ADDED_CHARACTERS));

    // A zero on both sides would satisfy the equality while proving nothing.
    expect(base.maxOutputTokens).toBeGreaterThan(0);
    expect(paidFor.maxOutputTokens).toBe(base.maxOutputTokens);
  });

  it('raises the input estimate by the tokens the characters just typed occupy', async () => {
    const before = await composerWith(TYPED);

    const after = await composerWith(TYPED + characters(ADDED_CHARACTERS));

    expect(after.estimatedInputTokens - before.estimatedInputTokens).toBe(
      inputTokensOf(ADDED_CHARACTERS)
    );
  });

  it('estimates the same input for a free payer as for a paid one', async () => {
    // Only the served payer tier changes; the input ratio is one value for every
    // payer, so the same characters occupy the same tokens.
    const forPaidPayer = await composerWith(TYPED);

    serve({ payerTier: 'free' });
    const forFreePayer = await composerWith(TYPED);

    expect(forFreePayer.estimatedInputTokens).toBe(forPaidPayer.estimatedInputTokens);
  });

  it('reprices a keystroke the server has never seen, without reading funding again', async () => {
    // The composed message has been sent nowhere: no request carries it, so no
    // server figure for it can exist. The estimate moves anyway, on one funding
    // read — which is what "computes per keystroke" means and what a served
    // figure could not do.
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) =>
        usePromptBudget({ value, historyCharacters: 0, conversationId: null }),
      { wrapper: createWrapper(), initialProps: { value: TYPED } }
    );
    await waitFor(() => {
      expect(result.current.fundingSource).toBe('personal_balance');
    });
    const typedTokens = result.current.estimatedInputTokens;
    const readsBefore = mockFundingReads.count;

    rerender({ value: TYPED + characters(ADDED_CHARACTERS) });

    await waitFor(() => {
      expect(result.current.estimatedInputTokens).toBeGreaterThan(typedTokens);
    });
    expect(mockFundingReads.count).toBe(readsBefore);
  });
});
