import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelectorButton } from './model-selector-button';
import type { Model } from '@hushbox/shared';

// Mock models hook to break the import chain that requires VITE_API_URL
vi.mock('@/hooks/models', () => ({
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

// Mock Link component used by ModelSelectorModal
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const mockModels: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    contextLength: 128_000,
    pricePerInputToken: 0.000_01,
    pricePerOutputToken: 0.000_03,
    capabilities: ['internet-search'],
    description: 'A powerful language model from OpenAI.',
    supportedParameters: ['web_search_options'],
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    contextLength: 200_000,
    pricePerInputToken: 0.000_003,
    pricePerOutputToken: 0.000_015,
    capabilities: ['internet-search'],
    description: 'Anthropic most intelligent model.',
    supportedParameters: [],
  },
];

describe('ModelSelectorButton', () => {
  it('renders with selected model name', () => {
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

    // Modal should be open - look for the search input (appears twice for mobile/desktop)
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });
  });

  it('closes modal after selection', async () => {
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

    // Double-click to toggle Claude into selection
    await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

    // Click confirm button to trigger onSelect and close modal
    await user.click(screen.getByRole('button', { name: /select.*model/i }));

    // Modal should close
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
    });

    expect(onSelect).toHaveBeenCalledWith(
      expect.arrayContaining([
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ])
    );
  });

  it('is disabled when disabled prop is true', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
        disabled
      />
    );

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('does not open modal when disabled', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
        disabled
      />
    );

    await user.click(screen.getByRole('button'));

    // Modal should not open
    expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
  });

  it('has accessible name', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveAccessibleName(/model/i);
  });

  it('has centered text', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-selector-button')).toHaveClass('justify-center');
  });

  it('displays "Smart Model" when auto-router is selected', () => {
    const modelsWithAutoRouter: Model[] = [
      ...mockModels,
      {
        id: 'openrouter/auto',
        name: 'Smart Model',
        provider: 'OpenRouter',
        contextLength: 2_000_000,
        pricePerInputToken: 0.000_000_039,
        pricePerOutputToken: 0.000_000_19,
        capabilities: [],
        description: 'Uses the best model for your task',
        supportedParameters: [],
        isAutoRouter: true,
      },
    ];

    render(
      <ModelSelectorButton
        models={modelsWithAutoRouter}
        selectedModels={[{ id: 'openrouter/auto', name: 'Smart Model' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('displays fallback name for auto-router before models load', () => {
    render(
      <ModelSelectorButton
        models={[]}
        selectedModels={[{ id: 'openrouter/auto', name: 'Smart Model' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('displays "Multiple Models" when 2+ models selected', () => {
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

    expect(screen.getByRole('button')).toHaveTextContent('Multiple Models');
  });

  it('displays shortened model name when 1 model selected via selectedModels', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('GPT-4 Turbo');
  });
});
