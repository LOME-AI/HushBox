/**
 * Whether a Smart-slot composer warns that the balance may shorten the reply.
 *
 * The producer chain runs unstubbed: `useTurnOptions`, `useBudgetCalculation`
 * and `usePromptBudget` all run, so the warning asserted here is decided by the
 * producer's graded candidates rather than handed to the hook. The stubs serve
 * its inputs and hold the composer's context fixed: the funding fetch
 * (`@/lib/api-client`, `@/lib/api/api`), the model catalog
 * (`@/hooks/models/models`), the model selection (`@/stores/model`), the
 * session (`@/lib/auth/auth`, `@/lib/auth/link-guest-auth`), the sender's tier,
 * the stability gate, the group budgets and the search toggle. The warning's
 * copy blames the balance, so it may show only when the balance is what holds
 * the answer.
 */

import * as React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { GetSpendableResponse, Model } from '@hushbox/shared';

interface Served {
  snapshot: { current: GetSpendableResponse };
  catalog: { current: Model[] };
}

const { snapshot, catalog } = vi.hoisted(
  (): Served => ({
    snapshot: {
      current: {
        spendableNanoUsd: '0',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'self',
        ownerFundingLimit: null,
      },
    },
    catalog: { current: [] },
  })
);

// `@/lib/api/api` validates the platform env at import; nothing here calls it.
vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/lib/api-client', () => ({
  client: { billing: { spendable: { $get: () => ({}) } } },
  fetchJson: () => Promise.resolve(snapshot.current),
}));

vi.mock('@/lib/auth/link-guest-auth', () => ({ getLinkGuestAuth: () => null }));

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

vi.mock('@/hooks/models/models', () => ({
  useModels: (): UseModelsStub => ({
    data: { models: catalog.current, premiumIds: new Set<string>() },
  }),
}));

// The Smart slot alone is selected.
vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  return {
    ...actual,
    useModelStore: (selector?: (state: unknown) => unknown) =>
      selectorFromState(
        createModelStoreStub({
          selections: {
            text: [{ id: SMART_MODEL_ID, name: 'Smart Model' }],
            image: [],
            audio: [],
            video: [],
          },
        })
      )(selector as (s: unknown) => unknown),
  };
});

/** A served text row at 10,000 / 30,000 nano per token whose provider cap is `maxOutputTokens`. */
function textRow(id: string, maxOutputTokens: number): Model {
  return {
    id,
    name: id,
    provider: 'Fictional',
    description: 'Text generation model.',
    modality: 'text',
    supportedParameters: [],
    contextLength: 128_000,
    created: OLD_RELEASE_SECONDS,
    maxOutputTokens,
    pricing: { anchorContextTokens: 1_000_000, inputPerToken: '10000', outputPerToken: '30000' },
  };
}

/** The Smart Model row the catalog serves beside its candidates. */
const SMART_ROW: Model = { ...textRow(SMART_MODEL_ID, 4000), isSmartModel: true };

/** The composer's notice ids for a Smart-slot turn once its answer is priced. */
async function warningsAt(spendable: string, candidates: Model[]): Promise<readonly string[]> {
  snapshot.current = { ...snapshot.current, spendableNanoUsd: spendable };
  catalog.current = [SMART_ROW, ...candidates];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(
    () => usePromptBudget({ value: 'x'.repeat(4000), historyCharacters: 0, conversationId: null }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children),
    }
  );
  await waitFor(() => {
    expect(result.current.isAffordabilitySettled).toBe(true);
    expect(result.current.maxOutputTokens).toBeGreaterThan(0);
  });
  return result.current.notifications.map((notice) => notice.id);
}

describe('the Smart slot’s low-balance warning', () => {
  beforeEach(() => {
    catalog.current = [];
  });

  it('stays silent when every candidate’s provider cap holds the answer at 4,000 tokens and the balance funds more', async () => {
    const ids = await warningsAt('10500000000', [
      textRow('vendor/a', 4000),
      textRow('vendor/b', 4000),
    ]);

    expect(ids).not.toContain('answer_may_be_shortened');
  });

  it('warns when the balance holds the candidates below the threshold', async () => {
    const ids = await warningsAt('250000000', [
      textRow('vendor/a', 200_000),
      textRow('vendor/b', 200_000),
    ]);

    expect(ids).toContain('answer_may_be_shortened');
  });
});
