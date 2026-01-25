import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelectorButton } from './model-selector-button';
import type { Model } from '@lome-chat/shared';

const mockModels: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    contextLength: 128_000,
    pricePerInputToken: 0.000_01,
    pricePerOutputToken: 0.000_03,
    capabilities: ['vision', 'functions', 'json-mode', 'streaming'],
    description: 'A powerful language model from OpenAI.',
    supportedParameters: [],
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    contextLength: 200_000,
    pricePerInputToken: 0.000_003,
    pricePerOutputToken: 0.000_015,
    capabilities: ['vision', 'functions', 'streaming'],
    description: 'Anthropic most intelligent model.',
    supportedParameters: [],
  },
];

describe('ModelSelectorButton', () => {
  it('renders with selected model name', () => {
    render(
      <ModelSelectorButton models={mockModels} selectedId="openai/gpt-4-turbo" onSelect={vi.fn()} />
    );

    expect(screen.getByRole('button')).toHaveTextContent('GPT-4 Turbo');
  });

  it('shows placeholder when no model selected', () => {
    render(<ModelSelectorButton models={mockModels} selectedId="" onSelect={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveTextContent('Select model');
  });

  it('opens modal when clicked', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorButton models={mockModels} selectedId="openai/gpt-4-turbo" onSelect={vi.fn()} />
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
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('button'));

    // Wait for modal to open (search input appears twice for mobile/desktop)
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });

    // Double-click to select a model
    await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

    // Modal should close
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
    });

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet');
  });

  it('is disabled when disabled prop is true', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
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
        selectedId="openai/gpt-4-turbo"
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
      <ModelSelectorButton models={mockModels} selectedId="openai/gpt-4-turbo" onSelect={vi.fn()} />
    );

    expect(screen.getByRole('button')).toHaveAccessibleName(/model/i);
  });

  it('has centered text', () => {
    render(
      <ModelSelectorButton models={mockModels} selectedId="openai/gpt-4-turbo" onSelect={vi.fn()} />
    );

    expect(screen.getByTestId('model-selector-button')).toHaveClass('justify-center');
  });
});
