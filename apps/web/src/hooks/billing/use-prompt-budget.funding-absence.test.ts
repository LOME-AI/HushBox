/**
 * What the composer's money gate answers when NOTHING about the payer's funding
 * has been read.
 *
 * The stub is the HTTP fetch behind the funding query. Everything above it runs
 * for real — `useSpendable`, `useFundingRead`, `useResolveBilling`,
 * `useBudgetCalculation`, `useTurnOptions` and `usePromptBudget` — so the
 * verdict asserted here is produced by the chain rather than handed to it.
 * Stubbing `useResolveBilling` or `usePromptBudget` instead, as the neighbouring
 * suites do for their own subjects, would assert a stub's return value and could
 * not see a substituted funding figure at all.
 *
 * Every turn here is a MEDIA turn, and that is load-bearing: a text turn prices
 * `estimatedCostNanoUsd` at `0n`, so a fabricated `0n` spendable satisfies
 * `0n >= 0n` and answers `personal_balance`. Only a positively priced turn makes
 * the substitution visible.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { resolveDrainDecision } from '@/hooks/chat/use-authenticated-chat';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { Model } from '@hushbox/shared';

interface SpendableWire {
  spendableNanoUsd: string;
  heldNanoUsd: string;
  payerTier: string;
  payer: string;
}

const { mockFundingFetch, mockTierInfo } = vi.hoisted(() => ({
  mockFundingFetch: { current: (): Promise<unknown> => Promise.resolve() },
  mockTierInfo: {
    current: {
      tier: 'paid' as const,
      purchasedBalanceNanoUsd: 10_000_000_000n,
      freeAllowanceNanoUsd: 0n,
    },
  },
}));

// The transport, and the only thing stubbed. `@/lib/api/api` shares the mock because
// it validates the platform env at import and the drain decision's module
// reaches it; nothing here calls either beyond the funding read.
vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/lib/api-client', () => ({
  client: { billing: { spendable: { $get: () => ({}) } } },
  fetchJson: () => mockFundingFetch.current(),
}));

vi.mock('@/lib/auth/link-guest-auth', () => ({ getLinkGuestAuth: () => null }));

vi.mock('@/hooks/billing/use-user-tier-info', () => ({
  useUserTierInfo: () => mockTierInfo.current,
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

const IMAGE_MODEL: Model = {
  id: 'image-model',
  name: 'Image Model',
  provider: 'Fictional',
  description: 'Image generation model.',
  modality: 'image',
  supportedParameters: [],
  contextLength: 128_000,
  created: OLD_RELEASE_SECONDS,
  maxOutputTokens: 4096,
  // A priced image model: `perImage` is what makes this turn's estimate
  // positive. Token rates are absent because the wire contract refuses them on
  // an image row, and a row the endpoint cannot emit proves nothing here.
  pricing: { perImage: '50000000', dearestPerImage: '50000000' },
};

vi.mock('@/hooks/models/models', () => ({
  // The return annotation is what binds the row to the wire contract: an
  // unannotated factory infers its own shape, so anything at all typechecks
  // in the catalog position.
  useModels: (): UseModelsStub => ({
    data: { models: [IMAGE_MODEL], premiumIds: new Set<string>() },
  }),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  return {
    ...actual,
    useModelStore: (selector?: (state: unknown) => unknown) => {
      const state = createModelStoreStub({
        activeModality: 'image',
        selections: {
          text: [],
          image: [{ id: 'image-model', name: 'Image Model' }],
          audio: [],
          video: [],
        },
      });
      return selectorFromState(state)(selector as (s: unknown) => unknown);
    },
  };
});

const COMPOSER_INPUT = { value: 'draw a cat', historyCharacters: 0, conversationId: null };

function renderGate(): ReturnType<typeof renderHook<ReturnType<typeof usePromptBudget>, unknown>> {
  // Retries off so an exhausted read is reached in one tick; the production
  // policy has already run by the time `isError` is set either way.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => usePromptBudget(COMPOSER_INPUT), {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children),
  });
}

/** A read that never settles: the ordinary in-flight state. */
function neverSettles(): void {
  mockFundingFetch.current = () =>
    new Promise<unknown>(() => {
      // Never resolves and never rejects, which is what "in flight" means.
    });
}

/** A read that fails: `useFundingRead` reports it exhausted rather than slow. */
function fails(): void {
  mockFundingFetch.current = () => Promise.reject(new Error('funding read failed'));
}

function serves(spendableNanoUsd: string): void {
  const wire: SpendableWire = {
    spendableNanoUsd,
    heldNanoUsd: '0',
    payerTier: 'paid',
    payer: 'self',
  };
  mockFundingFetch.current = () => Promise.resolve(wire);
}

describe('a media composer whose payer funding was never read', () => {
  beforeEach(() => {
    mockTierInfo.current = {
      tier: 'paid',
      purchasedBalanceNanoUsd: 10_000_000_000n,
      freeAllowanceNanoUsd: 0n,
    };
  });

  it('gives no verdict while the read is still in flight', () => {
    neverSettles();

    const { result } = renderGate();

    expect(result.current.fundingSource).toBe('no_verdict');
  });

  it('states nothing about the balance while the read is still in flight', () => {
    // This is the half the composer used to RENDER: the fabricated zero produced
    // a shortfall denial, and the notice gate keyed on the exhausted read alone
    // let it through.
    neverSettles();

    const { result } = renderGate();

    expect(result.current.notifications).toEqual([]);
  });

  it('leaves a queued media message queued while the read is still in flight', () => {
    neverSettles();

    const { result } = renderGate();

    expect(resolveDrainDecision(result.current)).toEqual({ kind: 'wait' });
  });

  it('gives no verdict once the read is exhausted', async () => {
    fails();

    const { result } = renderGate();

    await waitFor(() => {
      expect(result.current.sendRefusal).toBe('send_check_unavailable');
    });
    expect(result.current.fundingSource).toBe('no_verdict');
  });

  it('reports the exhausted read as refused rather than loading', async () => {
    // Asserted where the wiring is real: only the HTTP fetch is stubbed, so
    // `useFundingRead`, `useTurnOptions` and `useBudgetCalculation` all run and
    // all read the one cache entry. The funding read reports its exhausted arm
    // as its own state, so with the catalog in hand nothing the turn is priced
    // from is outstanding and the loading term is false while the refusal
    // stands.
    //
    // That is what keeps the busy affordance finite here: a
    // no-purchased-wallet 404 never resolves, and announcing a check forever
    // under a notice saying the check could not be made is the state this
    // asymmetry removes.
    fails();

    const { result } = renderGate();

    await waitFor(() => {
      expect(result.current.sendRefusal).toBe('send_check_unavailable');
    });
    expect(result.current.isBillingLoading).toBe(false);
  });

  it('leaves a queued media message queued once the read is exhausted', async () => {
    // The refuse arm latches the drain, so one transient read failure stranded
    // every message behind it long after the read recovered.
    fails();

    const { result } = renderGate();

    await waitFor(() => {
      expect(result.current.sendRefusal).toBe('send_check_unavailable');
    });
    expect(resolveDrainDecision(result.current)).toEqual({ kind: 'wait' });
  });

  it('names the payer wallet once the snapshot is served', async () => {
    serves('10500000000');

    const { result } = renderGate();

    await waitFor(() => {
      expect(result.current.fundingSource).toBe('personal_balance');
    });
  });

  it('reports the affordability producer unsettled while the read is in flight', () => {
    neverSettles();

    const { result } = renderGate();

    expect(result.current.isAffordabilitySettled).toBe(false);
  });

  it('reports the affordability producer settled once the read is exhausted', async () => {
    // Settled means resolved, not answered: a read that will never land leaves
    // every affordability readout at its final value, so a caller waiting for
    // one must stop waiting here rather than wait out a read that is over.
    fails();

    const { result } = renderGate();

    await waitFor(() => {
      expect(result.current.isAffordabilitySettled).toBe(true);
    });
  });

  it('reports the affordability producer settled once the snapshot is served', async () => {
    serves('10500000000');

    const { result } = renderGate();

    await waitFor(() => {
      expect(result.current.isAffordabilitySettled).toBe(true);
    });
  });

  it('still denies a served snapshot that cannot cover the turn', async () => {
    // The served path is untouched: a real shortfall is still a denial, and it
    // still says so.
    serves('1');

    const { result } = renderGate();

    await waitFor(() => {
      expect(result.current.fundingSource).toBe('denied');
    });
    expect(result.current.notifications.map((notice) => notice.id)).toContain('insufficient_funds');
  });
});
