// @vitest-environment jsdom
/**
 * What the composer presents when the payer's funding read HAS been served and
 * the model catalog has NOT arrived — and, above all, that the two ways it can
 * be absent present DIFFERENTLY. A catalog still in flight reads as busy and
 * says nothing; one whose read is exhausted refuses by name. Both were once the
 * same silent, unexplained, disabled button, which is what makes the difference
 * the thing this file exists to pin.
 *
 * The only seam stubbed for the subject is the HTTP transport behind
 * `@/lib/api-client`, dispatched per route: `billing.spendable` and
 * `billing.balance` answer, `models` does not. Everything above it runs for
 * real — `useModels`, `useFundingRead`, `useBudgetCalculation`,
 * `useTurnOptions`, `useResolveBilling`, `usePromptBudget`, and `PromptInput`
 * itself — so the button's accessible name asserted here is the one the
 * component computed, not one handed to it. The neighbouring
 * `prompt-input.test.tsx` stubs `usePromptBudget` wholesale and could not reach
 * this state at all; `use-prompt-budget.funding-absence.test.ts` stubs
 * `useModels`, which is the input this file withholds.
 *
 * `@/lib/auth/auth` is stubbed because the session is a second network seam,
 * not part of the subject. The composer is a solo text composer, so the group
 * budget and trial-remaining reads are disabled by their own `enabled` gates
 * rather than by a stub.
 *
 * A `FundingWitness` renders the funding read's status as text so every
 * assertion below is made after the served snapshot is in hand rather than
 * after an arbitrary flush — the precondition is observed, not assumed.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS, noticeText } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { renderWithProviders } from '@/test-utils/render';
import { createModelStoreStub, selectorFromState } from '@/test-utils/model-store-mock';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { useFundingRead } from '@/hooks/billing/use-spendable';
import { useTurnOptions } from '@/hooks/billing/use-turn-options';
import { useModels } from '@/hooks/models/models';
import { PromptInput } from '@/components/chat/input/prompt-input';
import type { PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';
import type { FundingRead } from '@/hooks/billing/use-spendable';
import type { UseTurnOptionsResult } from '@/hooks/billing/use-turn-options';
import type { Model, PromptBasis } from '@hushbox/shared';

interface RouteHandlers {
  current: Map<string, () => Promise<unknown>>;
}

const { mockRoutes } = vi.hoisted(() => ({
  mockRoutes: { current: new Map<string, () => Promise<unknown>>() } as RouteHandlers,
}));

// The env schema parses at import of `@/lib/api/api`, which the client module
// reaches; without this every test in the file fails to load.
vi.mock('@/lib/api/api', () => ({
  getApiUrl: (): string => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/lib/api-client', () => {
  /**
   * A stand-in for the Hono RPC client that records which route a request
   * names instead of building one, so the transport below can answer per route.
   */
  function routeProxy(path: string): unknown {
    return new Proxy(
      {},
      {
        get(_target, property): unknown {
          if (typeof property !== 'string') return undefined;
          if (property === '$get') return () => ({ route: path });
          return routeProxy(path === '' ? property : `${path}.${property}`);
        },
      }
    );
  }

  return {
    client: routeProxy(''),
    fetchJson: (request: unknown): Promise<unknown> => {
      const { route } = request as { route: string };
      const handler = mockRoutes.current.get(route);
      if (handler === undefined) {
        return Promise.reject(new Error(`no stub for route ${route}`));
      }
      return handler();
    },
  };
});

// The predicate comes from the real module rather than a second copy here: a
// mock that re-implemented it would agree with production only until one of
// them changed.
vi.mock('@/lib/auth/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth')>();
  return {
    selectInstructionsReadUnresolved: actual.selectInstructionsReadUnresolved,
    useSession: (): { data: { user: { id: string } }; isPending: boolean } => ({
      data: { user: { id: 'user-1' } },
      isPending: false,
    }),
    useAuthStore: (
      selector: (state: {
        customInstructions: string | null;
        customInstructionsStatus: 'pending' | 'absent' | 'present';
        user: { id: string } | null;
      }) => unknown
    ): unknown =>
      selector({
        customInstructions: null,
        customInstructionsStatus: 'absent',
        user: { id: 'user-1' },
      }),
  };
});

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const state = createModelStoreStub();
  const store = (selector?: (s: unknown) => unknown): unknown => selectorFromState(state)(selector);
  (store as unknown as Record<string, unknown>)['getState'] = (): unknown => state;
  (store as unknown as Record<string, unknown>)['setState'] = (): void => undefined;
  return { ...actual, useModelStore: store };
});

const SERVED_FUNDING = {
  spendableNanoUsd: '10500000000',
  heldNanoUsd: '0',
  payerTier: 'paid',
  payer: 'self',
};

const SERVED_BALANCE = {
  purchased: { balanceNanoUsd: '10500000000' },
};

/** A read that never settles: the ordinary in-flight state. */
function neverSettles(): Promise<unknown> {
  return new Promise<unknown>(() => {
    // Never resolves and never rejects, which is what "in flight" means.
  });
}

function serveFundingOnly(catalog: () => Promise<unknown>): void {
  mockRoutes.current = new Map<string, () => Promise<unknown>>([
    ['billing.spendable', () => Promise.resolve(SERVED_FUNDING)],
    ['billing.balance', () => Promise.resolve(SERVED_BALANCE)],
    ['models', catalog],
  ]);
}

/**
 * The catalog row for the selected model, served by the control below. Its only
 * job is to make the same harness produce an ENABLED send: without it, a
 * disabled button is evidence about the harness rather than about the absent
 * catalog.
 */
const TEXT_MODEL: Model = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'Fictional',
  description: 'A priced text model.',
  modality: 'text',
  supportedParameters: [],
  contextLength: 128_000,
  created: OLD_RELEASE_SECONDS,
  maxOutputTokens: 4096,
  pricing: { inputPerToken: '1000', outputPerToken: '2000' },
};

const COMPOSER_INPUT = { value: 'hello there', historyCharacters: 0, conversationId: null };
/** The probe's own basis: the composed message and nothing ahead of it. */
const PROBE_BASIS: PromptBasis = {
  systemChars: 0,
  instructionChars: 0,
  historyChars: 0,
  inputChars: COMPOSER_INPUT.value.length,
  attachmentBytes: 0,
};

interface ChainProbe {
  budget: PromptBudgetResult;
  funding: FundingRead;
  turnOptions: UseTurnOptionsResult;
  catalog: ReturnType<typeof useModels>;
}

function renderChain(): ReturnType<typeof renderHook<ChainProbe, unknown>> {
  // Retries off so an exhausted read is reached in one tick; the production
  // policy has already run by the time `isError` is set either way.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    (): ChainProbe => ({
      budget: usePromptBudget(COMPOSER_INPUT),
      funding: useFundingRead(true, null),
      turnOptions: useTurnOptions({ basis: PROBE_BASIS, isAuthenticated: true }),
      catalog: useModels(),
    }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children),
    }
  );
}

/** Publishes the funding read's status as text, so assertions wait on the real precondition. */
function FundingWitness(): React.JSX.Element {
  const { status } = useFundingRead(true, null);
  return <span>{`funding read: ${status}`}</span>;
}

interface ComposerPresentation {
  sendLabel: string | null;
  sendBusy: string | null;
  sendDisabled: boolean;
  noticeRendered: boolean;
  /** The notice's rendered sentence, or `null` when no notice is on screen. */
  noticeMessage: string | null;
}

async function renderComposer(): Promise<{
  sendButton: HTMLElement;
  presentation: () => ComposerPresentation;
}> {
  renderWithProviders(
    <>
      <FundingWitness />
      <PromptInput
        value="hello there"
        onChange={() => undefined}
        onSubmit={() => undefined}
        placeholder="Ask anything"
      />
    </>
  );
  await screen.findByText('funding read: served');
  const sendButton = screen.getByTestId(TEST_IDS.sendButton);
  return {
    sendButton,
    presentation: (): ComposerPresentation => {
      const notice = screen.queryByTestId(TEST_IDS.budgetMessages);
      return {
        sendLabel: sendButton.getAttribute('aria-label'),
        sendBusy: sendButton.getAttribute('aria-busy'),
        sendDisabled: sendButton.hasAttribute('disabled'),
        noticeRendered: notice !== null,
        noticeMessage: notice === null ? null : notice.textContent,
      };
    },
  };
}

describe('a text composer whose funding is served and whose catalog has not arrived yet', () => {
  beforeEach(() => {
    serveFundingOnly(neverSettles);
  });

  it('prices no tokens, so the turn carries no estimate', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.funding.status).toBe('served');
    });
    expect(result.current.catalog.data).toBeUndefined();
    expect(result.current.budget.estimatedCostNanoUsd).toBeUndefined();
  });

  it('withholds the token verdict, so the send gate has no option set', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.funding.status).toBe('served');
    });
    expect(result.current.turnOptions.options).toBeUndefined();
    expect(result.current.turnOptions.isPending).toBe(true);
    expect(result.current.turnOptions.isFundingUnavailable).toBe(false);
  });

  it('resolves billing to no verdict', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.funding.status).toBe('served');
    });
    expect(result.current.budget.fundingSource).toBe('no_verdict');
  });

  it('raises no refusal, because a read still in flight may yet answer', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.funding.status).toBe('served');
    });
    expect(result.current.budget.sendRefusal).toBeUndefined();
  });

  it('reports the turn as loading, because the catalog is one of the reads it waits on', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.funding.status).toBe('served');
    });
    expect(result.current.budget.isBillingLoading).toBe(true);
  });

  it('states nothing about the money', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.funding.status).toBe('served');
    });
    expect(result.current.budget.notifications).toEqual([]);
  });

  it('names the send control for the check it is waiting on', async () => {
    const { sendButton } = await renderComposer();

    await waitFor(() => {
      expect(sendButton).toHaveAttribute('aria-label', 'Checking what you can send');
    });
  });

  it('leaves the send control disabled', async () => {
    const { sendButton } = await renderComposer();

    expect(sendButton).toBeDisabled();
  });

  it('sets the busy state on the send control', async () => {
    const { sendButton } = await renderComposer();

    await waitFor(() => {
      expect(sendButton).toHaveAttribute('aria-busy', 'true');
    });
  });

  it('renders no notice in the composer, because nothing has been refused', async () => {
    await renderComposer();

    expect(screen.queryByTestId(TEST_IDS.budgetMessages)).not.toBeInTheDocument();
  });
});

describe('a text composer whose funding is served and whose catalog read is exhausted', () => {
  beforeEach(() => {
    serveFundingOnly(() => Promise.reject(new Error('catalog read failed')));
  });

  it('reaches the same absent catalog', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.catalog.isError).toBe(true);
    });
    expect(result.current.catalog.data).toBeUndefined();
  });

  it('resolves billing to no verdict', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.catalog.isError).toBe(true);
    });
    expect(result.current.budget.fundingSource).toBe('no_verdict');
  });

  it('refuses the send by name', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.budget.sendRefusal).toBe('send_check_unavailable');
    });
  });

  it('still reports the turn as loading, so the refusal is what stops the busy state', async () => {
    // The co-occurrence is the reason the busy affordance pairs the loading term
    // with the ABSENCE of a refusal: an absent catalog leaves the turn pending
    // whether the read is coming or gone, so the loading term alone would spin
    // this state forever.
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.budget.sendRefusal).toBe('send_check_unavailable');
    });
    expect(result.current.budget.isBillingLoading).toBe(true);
  });

  it('names the send control "Cannot send"', async () => {
    const { sendButton } = await renderComposer();

    await waitFor(() => {
      expect(sendButton).toHaveAttribute('aria-label', 'Cannot send');
    });
  });

  it('sets no busy state on the send control', async () => {
    const { sendButton, presentation } = await renderComposer();

    await waitFor(() => {
      expect(presentation().noticeRendered).toBe(true);
    });
    expect(sendButton).toHaveAttribute('aria-busy', 'false');
  });

  it('renders the refusal in the composer', async () => {
    const { presentation } = await renderComposer();

    await waitFor(() => {
      expect(presentation().noticeMessage).toBe(noticeText('send_check_unavailable'));
    });
  });
});

describe('the same composer once the catalog arrives', () => {
  beforeEach(() => {
    serveFundingOnly(() => Promise.resolve({ models: [TEXT_MODEL], premiumModelIds: [] }));
  });

  it('resolves billing to the payer wallet', async () => {
    const { result } = renderChain();

    await waitFor(() => {
      expect(result.current.budget.fundingSource).toBe('personal_balance');
    });
  });

  it('names the send control "Send"', async () => {
    const { sendButton } = await renderComposer();

    await waitFor(() => {
      expect(sendButton).toHaveAttribute('aria-label', 'Send');
    });
    expect(sendButton).toBeEnabled();
  });
});

describe('the two catalog absences, side by side', () => {
  it('tells them apart on screen', async () => {
    // One test rather than two, because the claim is about the DIFFERENCE: two
    // passing single-state tests could both hold while the presentations
    // silently converged again, which is the state this composer shipped in.
    serveFundingOnly(neverSettles);
    const inFlightComposer = await renderComposer();
    await waitFor(() => {
      expect(inFlightComposer.presentation().sendBusy).toBe('true');
    });
    const inFlight = inFlightComposer.presentation();
    cleanup();

    serveFundingOnly(() => Promise.reject(new Error('catalog read failed')));
    const exhaustedComposer = await renderComposer();
    await waitFor(() => {
      expect(exhaustedComposer.presentation().noticeRendered).toBe(true);
    });
    const exhausted = exhaustedComposer.presentation();

    expect(inFlight).toEqual({
      sendLabel: 'Checking what you can send',
      sendBusy: 'true',
      sendDisabled: true,
      noticeRendered: false,
      noticeMessage: null,
    });
    expect(exhausted).toEqual({
      sendLabel: 'Cannot send',
      sendBusy: 'false',
      sendDisabled: true,
      noticeRendered: true,
      noticeMessage: noticeText('send_check_unavailable'),
    });
  });
});
