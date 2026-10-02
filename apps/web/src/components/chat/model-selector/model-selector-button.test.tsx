import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelectorButton } from '@/components/chat/model-selector/model-selector-button';
import { modelSelectionLabel } from '@/lib/chat/model-info-facts';
import { DEFAULT_MODEL_ID } from '@/stores/model';
import type { Model } from '@hushbox/shared';

// The modal's floor hook rides the billing query stack — irrelevant to the
// button's own behavior, so it is mocked at the module seam.
// The picker's verdict source. Mocked here so this stays a unit test of the
// BUTTON: the real hook reaches react-query, the catalog and the model store.
vi.mock('@/hooks/billing/use-turn-options', () => ({
  usePickerOptions: () => ({
    isPending: false,
    affordable: undefined,
    smartSlotAvailability: undefined,
  }),
}));

// Mock models hook to break the import chain that requires VITE_API_URL
vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({
    data: { models: [], premiumIds: new Set() },
    isLoading: false,
  }),
  getAccessibleModelIds: (
    _models: unknown[],
    _premiumIds: Set<string>,
    _canAccessPremium: boolean
  ) => ({
    strongestId: 'openai/gpt-4-turbo',
    valueId: 'openai/gpt-4-turbo',
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

const mockModels: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    modality: 'text' as const,
    contextLength: 128_000,
    description: 'A powerful language model from OpenAI.',
    supportedParameters: [],
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    modality: 'text' as const,
    contextLength: 200_000,
    description: 'Anthropic most intelligent model.',
    supportedParameters: [],
    pricing: { inputPerToken: '3000', outputPerToken: '15000' },
  },
];

describe('ModelSelectorButton', () => {
  it('labels the chip with the selected model name', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('GPT-4 Turbo');
  });

  it('shows default model name when selectedModels is empty', () => {
    render(<ModelSelectorButton models={mockModels} selectedModels={[]} onSelect={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('labels several models with the one selection label the model readout shares', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
        ]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent(modelSelectionLabel('GPT-4 Turbo', 3));
  });

  it('reads several models as the first model then how many more', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('GPT-4 Turbo + 1');
  });

  it('sets the count of further models apart from the name, so the name alone truncates', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
        ]}
        onSelect={vi.fn()}
      />
    );

    const chip = screen.getByRole('button');
    expect(within(chip).getByText('GPT-4 Turbo')).not.toHaveTextContent('+');
    expect(chip.querySelector('[data-slot="model-count"]')).toHaveTextContent('+ 2');
  });

  it('draws the name and count as the one selection label the model readout shares', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button').textContent).toBe(modelSelectionLabel('GPT-4 Turbo', 2));
  });

  it('keeps the full name for a roomy composer and the short name for a compact one', () => {
    render(
      <ModelSelectorButton
        models={[]}
        selectedModels={[{ id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet-20240806' }]}
        onSelect={vi.fn()}
      />
    );

    const chip = screen.getByRole('button');
    const full = within(chip).getByText('Claude 3.5 Sonnet-20240806');
    const short = within(chip).getByText('Claude 3.5 Sonnet');
    expect(full).not.toBe(short);
  });

  it('draws one label when the short name is the name itself', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(within(screen.getByRole('button')).getAllByText('GPT-4 Turbo')).toHaveLength(1);
  });

  it('prefers the catalog name over the stored selection name', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'Stale Name' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('GPT-4 Turbo');
  });

  it('draws the first model swatch beside its name', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button').querySelector('[data-slot="swatch"]')).not.toBeNull();
  });

  it('draws the default model swatch before any model is selected', () => {
    const { unmount } = render(
      <ModelSelectorButton
        models={[]}
        selectedModels={[{ id: DEFAULT_MODEL_ID, name: 'Smart Model' }]}
        onSelect={vi.fn()}
      />
    );
    const defaultSwatch = screen.getByRole('button').querySelector('[data-slot="swatch"]');
    const expected = defaultSwatch?.className;
    unmount();

    render(<ModelSelectorButton models={[]} selectedModels={[]} onSelect={vi.fn()} />);

    expect(screen.getByRole('button').querySelector('[data-slot="swatch"]')?.className).toBe(
      expected
    );
  });

  it('names the chip for assistive tech by the model it holds', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveAccessibleName('Model: GPT-4 Turbo');
  });

  it('names the chip for assistive tech by the several-models label', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveAccessibleName('Model: GPT-4 Turbo + 1');
  });

  it('renders nothing beside the chip in its parent, open or closed', async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="slot">
        <ModelSelectorButton
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onSelect={vi.fn()}
        />
      </div>
    );

    const slot = screen.getByTestId('slot');
    expect([...slot.children]).toEqual([screen.getByTestId('model-selector-button')]);

    await user.click(screen.getByTestId('model-selector-button'));
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });
    expect([...slot.children]).toEqual([screen.getByTestId('model-selector-button')]);
  });

  it('opens modal when clicked', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });
  });

  it('closes modal after selection in default single mode (row click commits)', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('button'));

    // Wait for modal to open (search input appears twice for mobile/desktop)
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });

    // Single mode: clicking a row commits + closes immediately
    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
    });

    expect(onSelect).toHaveBeenCalledWith([
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    ]);
  });

  it('displays "Smart Model" when the Smart Model is selected', () => {
    const modelsWithSmartModel: Model[] = [
      ...mockModels,
      {
        id: 'smart-model',
        name: 'Smart Model',
        provider: 'HushBox',
        modality: 'text' as const,
        contextLength: 2_000_000,
        description: 'Uses the best model for your task',
        supportedParameters: [],
        isSmartModel: true,
        pricing: { inputPerToken: '39', outputPerToken: '190' },
      },
    ];

    render(
      <ModelSelectorButton
        models={modelsWithSmartModel}
        selectedModels={[{ id: 'smart-model', name: 'Smart Model' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('displays fallback name for Smart Model before models load', () => {
    render(
      <ModelSelectorButton
        models={[]}
        selectedModels={[{ id: 'smart-model', name: 'Smart Model' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('exposes aria-haspopup="dialog" so screen readers announce a popup trigger', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-selector-button')).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('exposes a stable HTML id for Maestro mobile tests that select by DOM id', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-selector-button')).toHaveAttribute(
      'id',
      'model-selector-button'
    );
  });

  it('reflects open/closed state via aria-expanded', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    const trigger = screen.getByTestId('model-selector-button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  });
});
