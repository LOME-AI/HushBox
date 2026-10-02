import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REFUSAL_CODES, type Availability, type Model, type RefusalCode } from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useUIModalsStore } from '@/stores/ui/modals';
import { usePremiumModelClick } from '@/hooks/models/use-premium-model-click';
import { ModelSelectorModal } from '@/components/chat/model-selector/model-selector-modal';

/**
 * What a click on a greyed row reaches. The produced verdict is doubled at the
 * producer seam so every refusal in the vocabulary can be put on a row — driving
 * nine reasons through the real arithmetic would need nine catalogs, and the
 * fact under test is the routing, not the grading.
 */
const { mockUsePickerOptions } = vi.hoisted(() => ({ mockUsePickerOptions: vi.fn() }));

vi.mock('@/hooks/billing/use-turn-options', () => ({
  usePickerOptions: (...args: unknown[]) => mockUsePickerOptions(...args) as unknown,
}));

vi.mock('@/lib/api/api', () => ({ getApiUrl: () => 'http://localhost:8787' }));
vi.mock('@/lib/api-client', () => ({ client: {}, fetchJson: vi.fn() }));

vi.mock('@/hooks/models/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models/models')>();
  return { ...actual, useModels: () => ({ data: undefined, isLoading: true }) };
});

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

const REFUSED_ID = 'meta-llama/llama-3.1-70b-instruct';
const REFUSED_NAME = 'Llama 3.1 70B';
const FUNDED_ID = 'anthropic/claude-3.5-sonnet';

const MODELS: Model[] = [
  {
    id: FUNDED_ID,
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    modality: 'text',
    contextLength: 200_000,
    description: 'A funded control row.',
    supportedParameters: [],
    pricing: { inputPerToken: '3000', outputPerToken: '15000' },
  },
  {
    id: REFUSED_ID,
    name: REFUSED_NAME,
    provider: 'Meta',
    modality: 'text',
    contextLength: 131_072,
    description: 'The row every case below refuses.',
    supportedParameters: [],
    pricing: { inputPerToken: '590', outputPerToken: '790' },
  },
];

/** Refuse the one row for `reason`; the control row stays available. */
function refuse(reason: RefusalCode): void {
  mockUsePickerOptions.mockReturnValue({
    isPending: false,
    affordable: {
      all: MODELS.map((model) => ({
        modelId: model.id,
        availability: (model.id === REFUSED_ID
          ? { available: false, reason }
          : { available: true }) satisfies Availability,
      })),
    },
  });
}

/**
 * The picker wired to the real paywall router, which is what chooses between
 * the two modals: signup for a payer with no account, payment for one who has
 * it. Doubling the router would assert the picker against a stand-in and leave
 * the destinations untested.
 */
function PaywallHarness({
  isAuthenticated,
}: Readonly<{ isAuthenticated: boolean }>): React.JSX.Element {
  const handlePremiumClick = usePremiumModelClick(MODELS, isAuthenticated);
  return (
    <ModelSelectorModal
      open
      onOpenChange={() => undefined}
      models={MODELS}
      selectedIds={new Set([FUNDED_ID])}
      onSelect={() => undefined}
      isAuthenticated={isAuthenticated}
      onPremiumClick={handlePremiumClick}
    />
  );
}

describe('ModelSelectorModal — activating a refused row', () => {
  beforeEach(() => {
    useModelStore.getState().setPickerMode('text', 'single');
    useModelStore.setState({
      activeModality: 'text',
      selections: {
        text: [{ id: FUNDED_ID, name: 'Claude 3.5 Sonnet' }],
        image: [],
        audio: [],
        video: [],
      },
    });
    useUIModalsStore.setState({
      signupModalOpen: false,
      paymentModalOpen: false,
      premiumModelName: undefined,
    });
  });

  // Enumerated from the vocabulary rather than listed here, so a refusal code
  // added later is covered by this case the day it is added instead of falling
  // back to the dead click this asserts against.
  it.each([...REFUSAL_CODES])('routes a row refused for %s to the paywall', async (reason) => {
    const onPremiumClick = vi.fn();
    refuse(reason);
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open
        onOpenChange={() => undefined}
        models={MODELS}
        selectedIds={new Set([FUNDED_ID])}
        onSelect={() => undefined}
        onPremiumClick={onPremiumClick}
      />
    );

    await user.click(screen.getByText(REFUSED_NAME));

    // The reason rides along so the door that opens can say something true of
    // why this row is greyed.
    expect(onPremiumClick).toHaveBeenCalledWith(REFUSED_ID, reason);
  });

  it('opens the signup modal for a payer with no account', async () => {
    refuse('premium_requires_account');
    const user = userEvent.setup();
    render(<PaywallHarness isAuthenticated={false} />);

    await user.click(screen.getByText(REFUSED_NAME));

    expect(useUIModalsStore.getState().signupModalOpen).toBe(true);
    expect(useUIModalsStore.getState().paymentModalOpen).toBe(false);
  });

  it('opens the payment modal for a signed-in payer short of funds', async () => {
    refuse('insufficient_funds');
    const user = userEvent.setup();
    render(<PaywallHarness isAuthenticated />);

    await user.click(screen.getByText(REFUSED_NAME));

    expect(useUIModalsStore.getState().paymentModalOpen).toBe(true);
    expect(useUIModalsStore.getState().signupModalOpen).toBe(false);
  });

  it('still commits an available row rather than routing it to the paywall', async () => {
    refuse('insufficient_funds');
    const onPremiumClick = vi.fn();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open
        onOpenChange={() => undefined}
        models={MODELS}
        selectedIds={new Set([FUNDED_ID])}
        onSelect={onSelect}
        onPremiumClick={onPremiumClick}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    expect(onSelect).toHaveBeenCalledWith([{ id: FUNDED_ID, name: 'Claude 3.5 Sonnet' }]);
    expect(onPremiumClick).not.toHaveBeenCalled();
  });

  it('drops a refused row already in the pending multi selection instead of routing it', async () => {
    refuse('insufficient_funds');
    useModelStore.getState().setPickerMode('text', 'multi');
    const onPremiumClick = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open
        onOpenChange={() => undefined}
        models={MODELS}
        selectedIds={new Set([FUNDED_ID, REFUSED_ID])}
        onSelect={() => undefined}
        onPremiumClick={onPremiumClick}
      />
    );

    await user.click(screen.getByText(REFUSED_NAME));

    expect(onPremiumClick).not.toHaveBeenCalled();
  });
});
