import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_ID_BUILDERS, type Model } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { useModelStore } from '@/stores/model';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import { ModelSelectorModal } from '@/components/chat/model-selector/model-selector-modal';
import type { ModelsData } from '@/hooks/models/models';

/**
 * The picker's verdict, produced for real. `usePickerOptions` is deliberately NOT
 * mocked here: the defect this file pins is which ARGUMENT the picker hands the
 * producer, and a doubled producer answers whatever the double was told to —
 * which is exactly why a green suite never saw the pin go missing. Only the two
 * data reads behind the producer (catalog, funding) are stood in for.
 */
vi.mock('@/lib/api/api', () => ({ getApiUrl: () => 'http://localhost:8787' }));
vi.mock('@/lib/api-client', () => ({ client: {}, fetchJson: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

const { mockFunding } = vi.hoisted(() => ({
  mockFunding: {
    current: {
      status: 'served' as const,
      snapshot: {
        spendableNanoUsd: '500000000',
        heldNanoUsd: '0',
        payerTier: 'paid' as const,
        payer: 'self' as const,
      },
    },
  },
}));

vi.mock('@/hooks/billing/use-spendable', () => ({
  useFundingRead: () => mockFunding.current,
}));

// The sender is signed out for this file's purposes only so the web-search
// term stays off; the PAYER's figures come from the funding read above.
vi.mock('@/lib/auth/auth', () => ({
  useSession: () => ({ data: undefined, isPending: false }),
  useAuthStore: (selector: (state: { customInstructions: string | null }) => unknown) =>
    selector({ customInstructions: null }),
}));

const { mockModels } = vi.hoisted(() => ({
  mockModels: { current: undefined as ModelsData | undefined },
}));

vi.mock('@/hooks/models/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models/models')>();
  return { ...actual, useModels: () => ({ data: mockModels.current, isLoading: false }) };
});

function catalogRow(
  id: string,
  pricing: { inputPerToken: string; outputPerToken: string },
  reasoning?: Model['reasoning']
): Model {
  return {
    id,
    name: id,
    provider: 'Probe',
    modality: 'text',
    created: OLD_RELEASE_SECONDS,
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    description: 'A probe model',
    supportedParameters: [],
    ...(reasoning === undefined ? {} : { reasoning }),
    pricing,
  };
}

/**
 * A reasoning model at a balance chosen so the pin — and nothing else — decides
 * its row: at $0.50 spendable it is affordable with the effort axis open and
 * unaffordable pinned at High.
 */
const REASONER = catalogRow(
  'reasoner',
  { inputPerToken: '10000', outputPerToken: '30000' },
  { supportedEfforts: ['low', 'medium', 'high'] }
);
const CATALOG = [REASONER];

/**
 * A model with no reasoning metadata at all: the effort axis offers it nothing,
 * not even off, so no pin resolves on it.
 */
const LADDERLESS = catalogRow('ladderless', { inputPerToken: '100', outputPerToken: '200' });

function renderPicker(models: Model[] = CATALOG): void {
  mockModels.current = { models, premiumIds: new Set<string>() };
  render(
    <ModelSelectorModal
      open
      onOpenChange={() => undefined}
      models={models}
      selectedIds={new Set(['reasoner'])}
      onSelect={() => undefined}
      activeModality="text"
    />
  );
}

function reasonerRow(): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.modelItem('reasoner'));
}

describe('ModelSelectorModal — the effort pin the picker grades at', () => {
  beforeEach(() => {
    mockModels.current = { models: CATALOG, premiumIds: new Set<string>() };
    useModelStore.setState({
      activeModality: 'text',
      selections: {
        text: [{ id: 'reasoner', name: 'reasoner' }],
        image: [],
        audio: [],
        video: [],
      },
    });
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'auto',
      enabledEffortChoices: undefined,
    });
  });

  it('greys a row the turn cannot fund at the pinned effort', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });

    renderPicker();

    expect(reasonerRow()).toHaveAttribute('data-unavailable', 'true');
  });

  it('leaves the same row available with the axis open, so the pin is what decided it', () => {
    renderPicker();

    expect(reasonerRow()).not.toHaveAttribute('data-unavailable');
  });

  /**
   * Selecting the row is what makes it answerable: the model leaves the
   * classifier pool, where a pin it cannot resolve withholds it, and joins the
   * pinned siblings, where it runs wire-silent. Grading the click's outcome from
   * the row's CURRENT role greyed every non-reasoning model under any explicit
   * preference, at any balance.
   */
  it('offers a row that cannot reason while a pinned sibling answers the effort', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'low' });

    renderPicker([REASONER, LADDERLESS]);

    expect(screen.getByTestId(TEST_ID_BUILDERS.modelItem('ladderless'))).not.toHaveAttribute(
      'data-unavailable'
    );
  });
});
