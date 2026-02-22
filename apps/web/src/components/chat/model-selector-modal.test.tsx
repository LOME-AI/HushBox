import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelectorModal } from './model-selector-modal';
import type { Model } from '@hushbox/shared';

// Mock Link component
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a href={to} className={className} onClick={onClick} data-testid="signup-link">
      {children}
    </a>
  ),
}));

function first<T>(array: T[]): T {
  const item = array[0];
  if (item === undefined) {
    throw new Error('Expected array to have at least one element');
  }
  return item;
}

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
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B',
    provider: 'Meta',
    contextLength: 131_072,
    pricePerInputToken: 0.000_000_59,
    pricePerOutputToken: 0.000_000_79,
    capabilities: ['functions', 'streaming'],
    description: 'Open-weight model offering excellent performance.',
    supportedParameters: [],
  },
];

describe('ModelSelectorModal', () => {
  it('renders all models when open', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
    expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
    expect(screen.getByText('Llama 3.1 70B')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <ModelSelectorModal
        open={false}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
  });

  it('filters models when searching', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const searchInputs = screen.getAllByPlaceholderText('Search models');
    await user.type(first(searchInputs), 'Claude');

    expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
    expect(screen.queryByText('Llama 3.1 70B')).not.toBeInTheDocument();
  });

  it('filters models by provider', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const searchInputs = screen.getAllByPlaceholderText('Search models');
    await user.type(first(searchInputs), 'openai');

    expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
    expect(screen.queryByText('Claude 3.5 Sonnet')).not.toBeInTheDocument();
  });

  it('shows model details when model is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic most intelligent model/)).toBeInTheDocument();
  });

  it('calls onSelect and closes when model is double-clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders Quick Select Model header', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getAllByText(/quick select model/i).length).toBeGreaterThan(0);
  });

  it('renders sections in order: Quick Select, Sort By, Search', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const quickSelectHeader = first(screen.getAllByText(/quick select model/i));
    const sortByHeader = first(screen.getAllByText(/sort by/i));
    const searchInput = first(screen.getAllByPlaceholderText('Search models'));

    // Quick Select should come before Sort By in the DOM
    expect(
      quickSelectHeader.compareDocumentPosition(sortByHeader) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // Sort By should come before Search in the DOM
    expect(
      sortByHeader.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('displays Memory capacity prefix with context length in model rows', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
    expect(gpt4Item).toHaveTextContent('Capacity: 128k');
  });

  it('renders Strongest button', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getAllByRole('button', { name: /strongest/i }).length).toBeGreaterThan(0);
  });

  it('renders Value button', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getAllByRole('button', { name: /value/i }).length).toBeGreaterThan(0);
  });

  it('selects strongest model and closes when Strongest button is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.click(first(screen.getAllByRole('button', { name: /strongest/i })));

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-opus-4.6');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('selects value model and closes when Value button is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.click(first(screen.getAllByRole('button', { name: /value/i })));

    expect(onSelect).toHaveBeenCalledWith('deepseek/deepseek-r1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows selected model highlighted', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const selectedItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
    expect(selectedItem).toHaveAttribute('data-selected', 'true');
  });

  it('shows details for initially selected model', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText(/A powerful language model/)).toBeInTheDocument();
  });

  it('displays capability badges', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('vision')).toBeInTheDocument();
  });

  it('formats context length correctly', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
  });

  it('displays prices with HushBox fee applied (15% markup)', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('$0.0115 / 1k')).toBeInTheDocument();
    expect(screen.getByText('$0.0345 / 1k')).toBeInTheDocument();
  });

  it('closes on Escape key', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('renders Select model button at bottom', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /select model/i })).toBeInTheDocument();
  });

  it('selects focused model and closes when Select model button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));
    await user.click(screen.getByRole('button', { name: /select model/i }));

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe('sorting', () => {
    it('renders Sort By section with Price and Context buttons', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      expect(screen.getAllByText(/sort by/i).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('button', { name: /price/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole('button', { name: /capacity/i }).length).toBeGreaterThan(0);
    });

    it('highlights Price button when clicked', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      const priceButtons = screen.getAllByRole('button', { name: /price/i });
      await user.click(first(priceButtons));

      expect(first(priceButtons)).toHaveAttribute('data-active', 'true');
    });

    it('toggles arrow direction when active button is clicked again', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      const priceButtons = screen.getAllByRole('button', { name: /price/i });

      await user.click(first(priceButtons));
      expect(first(priceButtons)).toHaveAttribute('data-direction', 'asc');

      await user.click(first(priceButtons));
      expect(first(priceButtons)).toHaveAttribute('data-direction', 'desc');
    });

    it('sorts models by price (input + output) ascending', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      expect(first(modelItems)).toHaveTextContent('Llama 3.1 70B');
    });

    it('sorts models by context length ascending', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /capacity/i })));

      const modelItems = screen.getAllByRole('option');
      expect(first(modelItems)).toHaveTextContent('GPT-4 Turbo');
    });
  });

  it('uses ScrollArea for right panel scrolling', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const rightPanel = screen.getByTestId('model-details-panel');
    expect(rightPanel).toHaveAttribute('data-slot', 'scroll-area');
  });

  describe('mobile layout split', () => {
    it('model list panel has flex-[9] for 45% of remaining space on mobile', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      const modelListPanel = screen.getByTestId('model-list-panel');
      expect(modelListPanel).toHaveClass('flex-[9]');
    });

    it('info panel has flex-[11] for 55% of remaining space on mobile', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      const detailsPanel = screen.getByTestId('model-details-panel');
      expect(detailsPanel).toHaveClass('flex-[11]');
    });
  });

  describe('premium models', () => {
    const premiumIds = new Set(['openai/gpt-4-turbo']);

    it('does not show Premium badge on any models (badges removed)', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item).not.toHaveTextContent('Premium');
    });

    it('shows lock icon on premium models for non-paid users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="lock-icon"]')).toBeInTheDocument();
    });

    it('does not show lock icon on basic models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const claudeItem = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      expect(claudeItem.querySelector('[data-testid="lock-icon"]')).not.toBeInTheDocument();
    });

    it('does not show lock icon for paid users on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="lock-icon"]')).not.toBeInTheDocument();
    });

    it('shows "Sign up to access" for trial users on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item).toHaveTextContent('Sign up');
      expect(gpt4Item).toHaveTextContent('to access');
    });

    it('renders "Sign up" as a clickable link for trial users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const signupLink = screen.getByTestId('signup-link');
      expect(signupLink).toHaveAttribute('href', '/signup');
      expect(signupLink).toHaveTextContent('Sign up');
      expect(signupLink).toHaveClass('text-primary');
    });

    it('shows "Top up to unlock" for free users on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item).toHaveTextContent('Top up');
      expect(gpt4Item).toHaveTextContent('to unlock');
    });

    it('renders "Top up" as a clickable link for free users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={true}
        />
      );

      const topUpLink = screen.getByRole('link', { name: 'Top up' });
      expect(topUpLink).toHaveAttribute('href', '/billing');
      expect(topUpLink).toHaveClass('text-primary');
    });

    it('shows tinted overlay on premium models for non-paid users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={false}
          isAuthenticated={false}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="premium-overlay"]')).toBeInTheDocument();
    });

    it('does not show overlay for paid users', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="premium-overlay"]')).not.toBeInTheDocument();
    });

    it('calls onSelect for premium model when canAccessPremium is true', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={true}
        />
      );

      await user.dblClick(screen.getByText('GPT-4 Turbo'));

      expect(onSelect).toHaveBeenCalledWith('openai/gpt-4-turbo');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('calls onPremiumClick instead of onSelect when canAccessPremium is false', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      await user.dblClick(screen.getByText('GPT-4 Turbo'));

      expect(onPremiumClick).toHaveBeenCalledWith('openai/gpt-4-turbo');
      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('allows selecting basic models when canAccessPremium is false', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

      expect(onSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onPremiumClick).not.toHaveBeenCalled();
    });

    it('calls onPremiumClick when Select model button clicked with premium model focused', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      await user.click(screen.getByText('GPT-4 Turbo'));
      await user.click(screen.getByRole('button', { name: /select model/i }));

      expect(onPremiumClick).toHaveBeenCalledWith('openai/gpt-4-turbo');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('does not show Premium badge in model details panel (badges removed)', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={vi.fn()}
          premiumIds={premiumIds}
        />
      );

      await user.click(screen.getByText('GPT-4 Turbo'));

      const detailsPanel = screen.getByTestId('model-details-panel');
      expect(detailsPanel).not.toHaveTextContent('Premium');
    });

    it('defaults canAccessPremium to true for backward compatibility', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedId="anthropic/claude-3.5-sonnet"
          onSelect={onSelect}
          premiumIds={premiumIds}
        />
      );

      await user.dblClick(screen.getByText('GPT-4 Turbo'));

      // Should call onSelect since canAccessPremium defaults to true
      expect(onSelect).toHaveBeenCalledWith('openai/gpt-4-turbo');
    });

    describe('interlacing during sorting', () => {
      // GPT-4 is premium, Claude and Llama are basic
      const interlaceModels: Model[] = [
        {
          id: 'basic-1',
          name: 'Basic Model 1',
          provider: 'Provider A',
          contextLength: 100_000,
          pricePerInputToken: 0.000_01,
          pricePerOutputToken: 0.000_02,
          capabilities: [],
          description: 'Basic model 1',
          supportedParameters: [],
        },
        {
          id: 'basic-2',
          name: 'Basic Model 2',
          provider: 'Provider B',
          contextLength: 200_000,
          pricePerInputToken: 0.000_03,
          pricePerOutputToken: 0.000_04,
          capabilities: [],
          description: 'Basic model 2',
          supportedParameters: [],
        },
        {
          id: 'premium-1',
          name: 'Premium Model 1',
          provider: 'Provider C',
          contextLength: 150_000,
          pricePerInputToken: 0.000_05,
          pricePerOutputToken: 0.000_06,
          capabilities: [],
          description: 'Premium model 1',
          supportedParameters: [],
        },
        {
          id: 'premium-2',
          name: 'Premium Model 2',
          provider: 'Provider D',
          contextLength: 250_000,
          pricePerInputToken: 0.000_07,
          pricePerOutputToken: 0.000_08,
          capabilities: [],
          description: 'Premium model 2',
          supportedParameters: [],
        },
      ];
      const interlacePremiumIds = new Set(['premium-1', 'premium-2']);

      it('interlaces basic and premium models during sorting for non-paid users', async () => {
        const user = userEvent.setup();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={interlaceModels}
            selectedId="basic-1"
            onSelect={vi.fn()}
            premiumIds={interlacePremiumIds}
            canAccessPremium={false}
            isAuthenticated={false}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /price/i })));

        const modelItems = screen.getAllByRole('option');
        expect(modelItems[0]).toHaveTextContent('Basic Model 1');
        expect(modelItems[1]).toHaveTextContent('Premium Model 1');
        expect(modelItems[2]).toHaveTextContent('Basic Model 2');
        expect(modelItems[3]).toHaveTextContent('Premium Model 2');
      });

      it('does not interlace models for paid users during sorting', async () => {
        const user = userEvent.setup();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={interlaceModels}
            selectedId="basic-1"
            onSelect={vi.fn()}
            premiumIds={interlacePremiumIds}
            canAccessPremium={true}
            isAuthenticated={true}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /price/i })));

        const modelItems = screen.getAllByRole('option');
        expect(modelItems[0]).toHaveTextContent('Basic Model 1');
        expect(modelItems[1]).toHaveTextContent('Basic Model 2');
        expect(modelItems[2]).toHaveTextContent('Premium Model 1');
        expect(modelItems[3]).toHaveTextContent('Premium Model 2');
      });

      it('interlaces in descending order when sort is descending for non-paid users', async () => {
        const user = userEvent.setup();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={interlaceModels}
            selectedId="basic-1"
            onSelect={vi.fn()}
            premiumIds={interlacePremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /price/i })));
        await user.click(first(screen.getAllByRole('button', { name: /price/i })));

        const modelItems = screen.getAllByRole('option');
        expect(modelItems[0]).toHaveTextContent('Basic Model 2');
        expect(modelItems[1]).toHaveTextContent('Premium Model 2');
        expect(modelItems[2]).toHaveTextContent('Basic Model 1');
        expect(modelItems[3]).toHaveTextContent('Premium Model 1');
      });
    });

    describe('quick select for non-paid users', () => {
      const quickSelectModels: Model[] = [
        {
          id: 'basic-cheap',
          name: 'Basic Cheap Model',
          provider: 'Provider A',
          contextLength: 100_000,
          pricePerInputToken: 0.000_01,
          pricePerOutputToken: 0.000_02,
          capabilities: [],
          description: 'Cheap basic model',
          supportedParameters: [],
        },
        {
          id: 'basic-expensive',
          name: 'Basic Expensive Model',
          provider: 'Provider B',
          contextLength: 200_000,
          pricePerInputToken: 0.000_05,
          pricePerOutputToken: 0.000_06,
          capabilities: [],
          description: 'Expensive basic model',
          supportedParameters: [],
        },
        {
          id: 'premium-model',
          name: 'Premium Model',
          provider: 'Provider C',
          contextLength: 150_000,
          pricePerInputToken: 0.0001,
          pricePerOutputToken: 0.000_12,
          capabilities: [],
          description: 'Premium model',
          supportedParameters: [],
        },
      ];
      const quickSelectPremiumIds = new Set(['premium-model']);

      it('selects highest cost basic model for "Strongest" when user is non-paid', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const onOpenChange = vi.fn();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={onOpenChange}
            models={quickSelectModels}
            selectedId="basic-cheap"
            onSelect={onSelect}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /strongest/i })));

        expect(onSelect).toHaveBeenCalledWith('basic-expensive');
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });

      it('selects lowest cost basic model for "Value" when user is non-paid', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const onOpenChange = vi.fn();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={onOpenChange}
            models={quickSelectModels}
            selectedId="basic-cheap"
            onSelect={onSelect}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /value/i })));

        expect(onSelect).toHaveBeenCalledWith('basic-cheap');
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });

      it('uses hardcoded model IDs for paid users regardless of available models', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const onOpenChange = vi.fn();
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={onOpenChange}
            models={quickSelectModels}
            selectedId="basic-cheap"
            onSelect={onSelect}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={true}
            isAuthenticated={true}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /strongest/i })));

        expect(onSelect).toHaveBeenCalledWith('anthropic/claude-opus-4.6');
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });

      it('excludes premium models when calculating dynamic quick select for non-paid users', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const onOpenChange = vi.fn();

        // Even though premium-model has highest price, it should be excluded
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={onOpenChange}
            models={quickSelectModels}
            selectedId="basic-cheap"
            onSelect={onSelect}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={false}
          />
        );

        await user.click(first(screen.getAllByRole('button', { name: /strongest/i })));

        expect(onSelect).toHaveBeenCalledWith('basic-expensive');
      });
    });
  });

  describe('expensive model warning', () => {
    const expensiveModels: Model[] = [
      {
        id: 'cheap-model',
        name: 'Cheap Model',
        provider: 'Provider A',
        contextLength: 100_000,
        // $0.01/1k input + $0.03/1k output = $0.046/1k with fees (below $0.10 threshold)
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
        capabilities: [],
        description: 'A cheap model',
        supportedParameters: [],
      },
      {
        id: 'expensive-model',
        name: 'Expensive Model',
        provider: 'Provider B',
        contextLength: 200_000,
        // $0.05/1k input + $0.05/1k output = $0.115/1k with fees (above $0.10 threshold)
        pricePerInputToken: 0.000_05,
        pricePerOutputToken: 0.000_05,
        capabilities: [],
        description: 'An expensive model',
        supportedParameters: [],
      },
    ];

    it('shows warning for expensive models', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={expensiveModels}
          selectedId="cheap-model"
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Expensive Model'));

      expect(screen.getByTestId('expensive-model-warning')).toBeInTheDocument();
      expect(screen.getByText('Long chats with this model can be costly')).toBeInTheDocument();
    });

    it('does not show warning for cheap models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={expensiveModels}
          selectedId="cheap-model"
          onSelect={vi.fn()}
        />
      );

      // Cheap model is initially selected
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('hides warning when switching from expensive to cheap model', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={expensiveModels}
          selectedId="expensive-model"
          onSelect={vi.fn()}
        />
      );

      // Initially shows warning for expensive model
      expect(screen.getByTestId('expensive-model-warning')).toBeInTheDocument();

      // Switch to cheap model
      await user.click(screen.getByText('Cheap Model'));

      // Warning should disappear
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });
  });
});
