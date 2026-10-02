import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  NOTICE_COPY,
  SELECTION_CAUSED_COPY,
  TEST_ID_BUILDERS,
  noticeTextOf,
  type Model,
} from '@hushbox/shared';
import { OLD_RELEASE_SECONDS, secondsAt } from '@hushbox/shared/test-time';
import { useModelStore } from '@/stores/model';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import { CATALOG_INSTANT_MS } from '@/hooks/billing/use-turn-options';
import { ModelSelectorModal } from '@/components/chat/model-selector/model-selector-modal';
import type { ModelsData } from '@/hooks/models/models';

/**
 * Which activation the picker grades a row on. The producer is deliberately NOT
 * doubled: the fact under test is that the arm a mode reads is the arm its click
 * makes, and a doubled set would hand back whatever arms the double declared.
 * Only the two reads behind the producer — catalog and funding — stand in.
 */
vi.mock('@/lib/api/api', () => ({ getApiUrl: () => 'http://localhost:8787' }));
vi.mock('@/lib/api-client', () => ({ client: {}, fetchJson: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

/**
 * No funding door, which is what makes the payer the TRIAL tier — the tier the
 * founder's symptom was reported on, and the one whose premium refusal names an
 * account rather than a balance.
 */
vi.mock('@/hooks/billing/use-spendable', () => ({
  useFundingRead: () => ({ status: 'no-door', snapshot: undefined }),
}));

vi.mock('@/lib/auth/auth', () => ({
  useSession: () => ({ data: undefined, isPending: false }),
  useAuthStore: (selector: (state: { customInstructions: string | null }) => unknown) =>
    selector({ customInstructions: null }),
}));

const { mockCatalog } = vi.hoisted(() => ({
  mockCatalog: { current: undefined as ModelsData | undefined },
}));

vi.mock('@/hooks/models/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models/models')>();
  return { ...actual, useModels: () => ({ data: mockCatalog.current, isLoading: false }) };
});

function catalogRow(id: string, overrides: Partial<Model> = {}): Model {
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
    pricing: { inputPerToken: '10', outputPerToken: '20' },
    popularityRank: 1,
    ...overrides,
  };
}

/**
 * Premium by RECENCY, measured against the same instant the producer grades the
 * catalog at. A two-model pool has no meaningful price percentile, so recency is
 * the leg that classifies here.
 */
const PINNED_PREMIUM = catalogRow('vendor/premium', {
  name: 'Premium Pin',
  created: secondsAt(CATALOG_INSTANT_MS),
});

/** Cheap, old, and runnable by a trial payer on its own account. */
const CHEAP = catalogRow('vendor/cheap', { name: 'Cheap Row', popularityRank: 2 });

const MODELS = [PINNED_PREMIUM, CHEAP];

function renderPicker(
  mode: 'single' | 'multi',
  onSelect: (picked: { id: string; name: string }[]) => void = () => undefined
): void {
  mockCatalog.current = { models: MODELS, premiumIds: new Set([PINNED_PREMIUM.id]) };
  useModelStore.getState().setPickerMode('text', mode);
  useModelStore.setState({
    activeModality: 'text',
    selections: {
      text: [{ id: PINNED_PREMIUM.id, name: PINNED_PREMIUM.name }],
      image: [],
      audio: [],
      video: [],
    },
  });
  render(
    <ModelSelectorModal
      open
      onOpenChange={() => undefined}
      models={MODELS}
      selectedIds={new Set([PINNED_PREMIUM.id])}
      onSelect={onSelect}
      isAuthenticated={false}
      premiumIds={new Set([PINNED_PREMIUM.id])}
      activeModality="text"
    />
  );
}

function rowFor(id: string): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.modelItem(id));
}

describe('ModelSelectorModal — the arm a click is graded on', () => {
  beforeEach(() => {
    mockCatalog.current = undefined;
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'auto',
      enabledEffortChoices: undefined,
    });
  });

  it('offers a row a single click would run alone, beside a pin the tier refuses', () => {
    renderPicker('single');

    expect(rowFor(CHEAP.id)).not.toHaveAttribute('data-unavailable');
  });

  it('commits that row, so the offer is not a dead click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker('single', onSelect);

    await user.click(screen.getByText(CHEAP.name));

    expect(onSelect).toHaveBeenCalledWith([{ id: CHEAP.id, name: CHEAP.name }]);
  });

  it('still refuses the premium pin itself in single mode', () => {
    renderPicker('single');

    expect(rowFor(PINNED_PREMIUM.id)).toHaveAttribute('data-unavailable', 'true');
  });

  it('refuses that same row in multi mode, where the click really does add it', () => {
    renderPicker('multi');

    expect(rowFor(CHEAP.id)).toHaveAttribute('data-unavailable', 'true');
  });

  it('words the multi refusal as the selection`s doing, remedy and removal both', () => {
    renderPicker('multi');

    expect(rowFor(CHEAP.id)).toHaveTextContent(
      noticeTextOf(SELECTION_CAUSED_COPY.premium_requires_account)
    );
  });

  it('words a row refused on its own account with the ordinary copy', () => {
    renderPicker('multi');

    expect(rowFor(PINNED_PREMIUM.id)).toHaveTextContent(
      noticeTextOf(NOTICE_COPY.premium_requires_account)
    );
  });

  it('draws its quick-select pins from the rows the mode`s own arm cleared', () => {
    // The pins are computed over the rows the verdict left available, so under
    // the ADD arm a trial payer holding a premium pin has no candidate to crown
    // and the picker offers no pin at all.
    renderPicker('single');

    expect(rowFor(CHEAP.id)).toHaveTextContent(/Strongest|Value/);
  });
});
