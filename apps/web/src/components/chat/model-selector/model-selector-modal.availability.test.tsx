import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SMART_MODEL_ID, TEST_ID_BUILDERS, modelSchema, type Model } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { useModelStore } from '@/stores/model';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import { ModelSelectorModal } from '@/components/chat/model-selector/model-selector-modal';
import type { ModelsData } from '@/hooks/models/models';

/**
 * Which rows the picker grades, and what it does with a row the produced set
 * holds no entry for. `usePickerOptions` is deliberately NOT mocked: a doubled
 * producer hands back whatever the double was told to, and the fact under test
 * is what the REAL set does and does not contain. Only the two data reads behind
 * the producer (catalog, funding) are stood in for.
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
        spendableNanoUsd: '5000000000',
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
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
    ...overrides,
  };
}

const FIRST = catalogRow('vendor/first');
const SECOND = catalogRow('vendor/second');

/** The synthetic slot row. It carries no rates of its own, so no pool holds it. */
const SMART = catalogRow(SMART_MODEL_ID, { name: 'Smart Model', isSmartModel: true });

/**
 * A served row the pool projection drops: the wire makes the release date
 * optional, and premium classification's recency leg has nothing to measure
 * without one. It renders in the picker and appears in no produced set.
 */
const UNDATED = catalogRow('vendor/undated', { created: undefined });

/** A second undated row, so a text catalog can be made of nothing but drops. */
const ALSO_UNDATED = catalogRow('vendor/also-undated', { created: undefined });

const IMAGE_FIRST = catalogRow('vendor/image-first', { modality: 'image' });
const IMAGE_SECOND = catalogRow('vendor/image-second', { modality: 'image' });

function renderPicker(
  models: Model[],
  selected: readonly string[],
  onSelect: (picked: { id: string; name: string }[]) => void = () => undefined
): void {
  mockCatalog.current = { models, premiumIds: new Set<string>() };
  useModelStore.setState({
    activeModality: 'text',
    selections: {
      text: selected.map((id) => ({ id, name: id })),
      image: [],
      audio: [],
      video: [],
    },
  });
  render(
    <ModelSelectorModal
      open
      onOpenChange={() => undefined}
      models={models}
      selectedIds={new Set(selected)}
      onSelect={onSelect}
      activeModality="text"
    />
  );
}

/**
 * The same picker on a per-unit modality. The token producer refuses an image
 * turn WHOLE — one refusal, no entries — so this is the one surface where a set
 * exists and grades nothing.
 */
function renderMediaPicker(models: Model[], selected: readonly string[]): void {
  mockCatalog.current = { models, premiumIds: new Set<string>() };
  useModelStore.getState().setPickerMode('image', 'single');
  useModelStore.setState({
    activeModality: 'image',
    selections: {
      text: [],
      image: selected.map((id) => ({ id, name: id })),
      audio: [],
      video: [],
    },
  });
  render(
    <ModelSelectorModal
      open
      onOpenChange={() => undefined}
      models={models}
      selectedIds={new Set(selected)}
      onSelect={() => undefined}
      activeModality="image"
    />
  );
}

function rowFor(id: string): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.modelItem(id));
}

describe('ModelSelectorModal — rows the produced set holds no entry for', () => {
  beforeEach(() => {
    mockCatalog.current = undefined;
    useModelStore.getState().setPickerMode('text', 'single');
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'auto',
      enabledEffortChoices: undefined,
    });
  });

  it('greys the Smart row when every affordable model is already pinned', () => {
    renderPicker([SMART, FIRST, SECOND], ['vendor/first', 'vendor/second']);

    expect(rowFor(SMART_MODEL_ID)).toHaveAttribute('data-unavailable', 'true');
  });

  it('refuses to select the Smart row it greyed', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker([SMART, FIRST, SECOND], ['vendor/first', 'vendor/second'], onSelect);

    await user.click(screen.getByText('Smart Model'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('leaves the Smart row available while a model is left for the slot to pick', () => {
    renderPicker([SMART, FIRST, SECOND], ['vendor/first']);

    expect(rowFor(SMART_MODEL_ID)).not.toHaveAttribute('data-unavailable');
  });

  it('selects that same Smart row, so the refusal above is the empty pool and not the row', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker([SMART, FIRST, SECOND], ['vendor/first'], onSelect);

    await user.click(screen.getByText('Smart Model'));

    expect(onSelect).toHaveBeenCalledWith([{ id: SMART_MODEL_ID, name: 'Smart Model' }]);
  });

  it('refuses a row the produced set did not grade', () => {
    renderPicker([FIRST, UNDATED], ['vendor/first']);

    expect(rowFor('vendor/undated')).toHaveAttribute('data-unavailable', 'true');
    // The graded row beside it is untouched, so the refusal is the missing
    // entry's and not the whole set's.
    expect(rowFor('vendor/first')).not.toHaveAttribute('data-unavailable');
  });

  it('leaves every row neutral while no verdict has been produced', () => {
    // The catalog read is still outstanding, so the producer is never reached.
    // A pending read is not a refusal, and the row that has no entry in a
    // produced set must not be greyed by a set that does not exist.
    render(
      <ModelSelectorModal
        open
        onOpenChange={() => undefined}
        models={[FIRST, UNDATED]}
        selectedIds={new Set(['vendor/first'])}
        onSelect={() => undefined}
        activeModality="text"
      />
    );

    expect(rowFor('vendor/undated')).not.toHaveAttribute('data-unavailable');
    expect(rowFor('vendor/first')).not.toHaveAttribute('data-unavailable');
  });

  it('leaves every row neutral when the token producer refused the modality whole', () => {
    // Both rows name a per-unit modality over the base's token rates, which the
    // wire contract refuses: a model priced per token is not an image model. The
    // control differs from them by that override alone, so the refusal is pinned
    // on the override rather than on anything else the base carries.
    expect(
      [catalogRow('vendor/image-first'), IMAGE_FIRST, IMAGE_SECOND].map(
        (row) => modelSchema.safeParse(row).success
      )
    ).toEqual([true, false, false]);

    // An image picker holds a produced set that graded nothing, because the
    // token core prices no per-unit model. Its rows are ungraded, not refused —
    // greying them would grey the entire media picker.
    renderMediaPicker([IMAGE_FIRST, IMAGE_SECOND], ['vendor/image-first']);

    expect(rowFor('vendor/image-second')).not.toHaveAttribute('data-unavailable');
    expect(rowFor('vendor/image-first')).not.toHaveAttribute('data-unavailable');
  });

  it('refuses every row of a text set whose rows the projection all dropped', () => {
    // A slot-only selection over a catalog the projection empties is the text
    // set that grades nothing: no id was named, so not even an unpriceable row
    // is emitted. The modality is one the producer does price, so these rows
    // have an answer and it is a refusal.
    renderPicker([SMART, UNDATED, ALSO_UNDATED], [SMART_MODEL_ID]);

    expect(rowFor('vendor/undated')).toHaveAttribute('data-unavailable', 'true');
    expect(rowFor('vendor/also-undated')).toHaveAttribute('data-unavailable', 'true');
  });
});
