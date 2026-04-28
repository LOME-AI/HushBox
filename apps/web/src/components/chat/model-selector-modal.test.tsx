import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelectorModal } from './model-selector-modal';
import type { Model } from '@hushbox/shared';

// Mock the api module to break the import chain that requires VITE_API_URL
vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@/lib/api-client', () => ({
  client: {},
  fetchJson: vi.fn(),
}));

// Mock Link component and useNavigate
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
  useNavigate: () => vi.fn(),
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
    modality: 'text' as const,
    contextLength: 128_000,
    pricePerInputToken: 0.000_01,
    pricePerOutputToken: 0.000_03,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: ['internet-search'],
    description: 'A powerful language model from OpenAI.',
    supportedParameters: ['web_search_options'],
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    modality: 'text' as const,
    contextLength: 200_000,
    pricePerInputToken: 0.000_003,
    pricePerOutputToken: 0.000_015,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: ['internet-search'],
    description: 'Anthropic most intelligent model.',
    supportedParameters: ['web_search_options'],
  },
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B',
    provider: 'Meta',
    modality: 'text' as const,
    contextLength: 131_072,
    pricePerInputToken: 0.000_000_59,
    pricePerOutputToken: 0.000_000_79,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic most intelligent model/)).toBeInTheDocument();
  });

  it('calls onSelect and closes when model is double-clicked then confirmed', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={onSelect}
      />
    );

    // Double-click toggles Claude into local selection
    await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

    // Click confirm button to trigger onSelect
    await user.click(screen.getByRole('button', { name: /select.*model/i }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.arrayContaining([
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ])
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render Quick Select section', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.queryByText(/quick select model/i)).not.toBeInTheDocument();
  });

  it('renders sections in order: Sort, Search', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const sortLabel = first(screen.getAllByText('Sort:'));
    const searchInput = first(screen.getAllByPlaceholderText('Search models'));

    // Sort should come before Search in the DOM
    expect(
      sortLabel.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('displays Memory capacity prefix with context length in model rows', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
    expect(gpt4Item).toHaveTextContent('Capacity: 128k');
  });

  describe('pinned model labels', () => {
    const pinnedModels: Model[] = [
      {
        id: 'anthropic/claude-opus-4.6',
        name: 'Claude Opus 4.6',
        provider: 'Anthropic',
        modality: 'text' as const,
        contextLength: 200_000,
        pricePerInputToken: 0.000_015,
        pricePerOutputToken: 0.000_075,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: ['internet-search'],
        description: 'Most capable model.',
        supportedParameters: ['web_search_options'],
      },
      {
        id: 'openai/gpt-5-nano',
        name: 'GPT-5 Nano',
        provider: 'OpenAI',
        modality: 'text' as const,
        contextLength: 128_000,
        pricePerInputToken: 0.000_000_1,
        pricePerOutputToken: 0.000_000_4,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'Cheapest tier-1 text model.',
        supportedParameters: [],
      },
      {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        provider: 'OpenAI',
        modality: 'text' as const,
        contextLength: 128_000,
        pricePerInputToken: 0.000_005,
        pricePerOutputToken: 0.000_015,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: ['internet-search'],
        description: 'Fast and capable model.',
        supportedParameters: ['web_search_options'],
      },
    ];

    it('shows "Strongest" label on strongest model subtitle row', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const strongestItem = screen.getByTestId('model-item-anthropic/claude-opus-4.6');
      expect(strongestItem).toHaveTextContent('Strongest');
    });

    it('shows "Best value" label on value model subtitle row', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const valueItem = screen.getByTestId('model-item-openai/gpt-5-nano');
      expect(valueItem).toHaveTextContent('Best value');
    });

    it('pins strongest and value models at top when no sort or filter is active', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Claude Opus 4.6');
      expect(modelItems[1]).toHaveTextContent('GPT-5 Nano');
      expect(modelItems[2]).toHaveTextContent('GPT-4o');
    });

    it('does not pin models when sort is active', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      // Sorted by price ascending — DeepSeek R1 is cheapest
      expect(modelItems[0]).toHaveTextContent('GPT-5 Nano');
    });

    it('shows labels regardless of sort state', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={pinnedModels}
          selectedIds={new Set(['openai/gpt-4o'])}
          onSelect={vi.fn()}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const strongestItem = screen.getByTestId('model-item-anthropic/claude-opus-4.6');
      expect(strongestItem).toHaveTextContent('Strongest');

      const valueItem = screen.getByTestId('model-item-openai/gpt-5-nano');
      expect(valueItem).toHaveTextContent('Best value');
    });
  });

  it('shows selected model highlighted', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Internet Search')).toBeInTheDocument();
  });

  it('formats context length correctly', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /select model/i })).toBeInTheDocument();
  });

  it('confirms current selection and closes when Select model button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedIds={new Set(['openai/gpt-4-turbo'])}
        onSelect={onSelect}
      />
    );

    // Click to focus Claude (does not change selection)
    await user.click(screen.getByText('Claude 3.5 Sonnet'));
    // Double-click to toggle Claude into selection
    await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));
    await user.click(screen.getByRole('button', { name: /select.*model/i }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.arrayContaining([
        { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ])
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe('sorting', () => {
    it('renders inline Sort label with Price and Capacity buttons', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getAllByText('Sort:').length).toBeGreaterThan(0);
      expect(screen.queryByText(/sort by/i)).not.toBeInTheDocument();
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
          selectedIds={new Set(['openai/gpt-4-turbo'])}
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
          selectedIds={new Set(['openai/gpt-4-turbo'])}
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
          selectedIds={new Set(['openai/gpt-4-turbo'])}
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
          selectedIds={new Set(['openai/gpt-4-turbo'])}
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
        selectedIds={new Set(['openai/gpt-4-turbo'])}
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
          selectedIds={new Set(['openai/gpt-4-turbo'])}
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
          selectedIds={new Set(['openai/gpt-4-turbo'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={vi.fn()}
          premiumIds={premiumIds}
          canAccessPremium={true}
          isAuthenticated={true}
        />
      );

      const gpt4Item = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gpt4Item.querySelector('[data-testid="premium-overlay"]')).not.toBeInTheDocument();
    });

    it('does not show overlay for link guests on premium models', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-3.5-turbo'])}
          onSelect={vi.fn()}
          premiumIds={new Set(['openai/gpt-4-turbo'])}
          canAccessPremium={false}
          isAuthenticated={false}
          isLinkGuest={true}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={true}
        />
      );

      // Double-click toggles GPT-4 Turbo into selection
      await user.dblClick(screen.getByText('GPT-4 Turbo'));
      await user.click(screen.getByRole('button', { name: /select.*model/i }));

      expect(onSelect).toHaveBeenCalledWith(
        expect.arrayContaining([
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        ])
      );
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      // Double-click toggles Claude into selection
      await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));
      await user.click(screen.getByRole('button', { name: /select.*model/i }));

      expect(onSelect).toHaveBeenCalledWith(
        expect.arrayContaining([
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ])
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onPremiumClick).not.toHaveBeenCalled();
    });

    it('calls onPremiumClick when premium model is double-clicked by non-paid user', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      const onPremiumClick = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
          canAccessPremium={false}
          onPremiumClick={onPremiumClick}
        />
      );

      // Double-click on premium model triggers onPremiumClick instead of toggling
      await user.dblClick(screen.getByText('GPT-4 Turbo'));

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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
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
          selectedIds={new Set(['anthropic/claude-3.5-sonnet'])}
          onSelect={onSelect}
          premiumIds={premiumIds}
        />
      );

      // Double-click toggles GPT-4 Turbo into selection (canAccessPremium defaults to true)
      await user.dblClick(screen.getByText('GPT-4 Turbo'));
      await user.click(screen.getByRole('button', { name: /select.*model/i }));

      // Should call onSelect since canAccessPremium defaults to true
      expect(onSelect).toHaveBeenCalledWith(
        expect.arrayContaining([
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
        ])
      );
    });

    describe('interlacing during sorting', () => {
      // GPT-4 is premium, Claude and Llama are basic
      const interlaceModels: Model[] = [
        {
          id: 'basic-1',
          name: 'Basic Model 1',
          provider: 'Provider A',
          modality: 'text' as const,
          contextLength: 100_000,
          pricePerInputToken: 0.000_01,
          pricePerOutputToken: 0.000_02,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Basic model 1',
          supportedParameters: [],
        },
        {
          id: 'basic-2',
          name: 'Basic Model 2',
          provider: 'Provider B',
          modality: 'text' as const,
          contextLength: 200_000,
          pricePerInputToken: 0.000_03,
          pricePerOutputToken: 0.000_04,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Basic model 2',
          supportedParameters: [],
        },
        {
          id: 'premium-1',
          name: 'Premium Model 1',
          provider: 'Provider C',
          modality: 'text' as const,
          contextLength: 150_000,
          pricePerInputToken: 0.000_05,
          pricePerOutputToken: 0.000_06,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Premium model 1',
          supportedParameters: [],
        },
        {
          id: 'premium-2',
          name: 'Premium Model 2',
          provider: 'Provider D',
          modality: 'text' as const,
          contextLength: 250_000,
          pricePerInputToken: 0.000_07,
          pricePerOutputToken: 0.000_08,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
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
            selectedIds={new Set(['basic-1'])}
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
            selectedIds={new Set(['basic-1'])}
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
            selectedIds={new Set(['basic-1'])}
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

    describe('pinned labels for non-paid users', () => {
      const quickSelectModels: Model[] = [
        {
          id: 'basic-cheap',
          name: 'Basic Cheap Model',
          provider: 'Provider A',
          modality: 'text' as const,
          contextLength: 100_000,
          pricePerInputToken: 0.000_01,
          pricePerOutputToken: 0.000_02,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Cheap basic model',
          supportedParameters: [],
        },
        {
          id: 'basic-expensive',
          name: 'Basic Expensive Model',
          provider: 'Provider B',
          modality: 'text' as const,
          contextLength: 200_000,
          pricePerInputToken: 0.000_05,
          pricePerOutputToken: 0.000_06,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Expensive basic model',
          supportedParameters: [],
        },
        {
          id: 'premium-model',
          name: 'Premium Model',
          provider: 'Provider C',
          modality: 'text' as const,
          contextLength: 150_000,
          pricePerInputToken: 0.0001,
          pricePerOutputToken: 0.000_12,
          pricePerImage: 0,
          pricePerSecondByResolution: {},
          pricePerSecond: 0,
          capabilities: [],
          description: 'Premium model',
          supportedParameters: [],
        },
      ];
      const quickSelectPremiumIds = new Set(['premium-model']);

      it('shows "Strongest" label on highest cost basic model for non-paid users', () => {
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={quickSelectModels}
            selectedIds={new Set(['basic-cheap'])}
            onSelect={vi.fn()}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        const strongestItem = screen.getByTestId('model-item-basic-expensive');
        expect(strongestItem).toHaveTextContent('Strongest');
      });

      it('shows "Best value" label on lowest cost basic model for non-paid users', () => {
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={quickSelectModels}
            selectedIds={new Set(['basic-cheap'])}
            onSelect={vi.fn()}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={true}
          />
        );

        const valueItem = screen.getByTestId('model-item-basic-cheap');
        expect(valueItem).toHaveTextContent('Best value');
      });

      it('excludes premium models from strongest/value label calculation', () => {
        render(
          <ModelSelectorModal
            open={true}
            onOpenChange={vi.fn()}
            models={quickSelectModels}
            selectedIds={new Set(['basic-cheap'])}
            onSelect={vi.fn()}
            premiumIds={quickSelectPremiumIds}
            canAccessPremium={false}
            isAuthenticated={false}
          />
        );

        // Premium model should NOT have the Strongest label even though it's most expensive
        const premiumItem = screen.getByTestId('model-item-premium-model');
        expect(premiumItem).not.toHaveTextContent('Strongest');
        expect(premiumItem).not.toHaveTextContent('Best value');
      });
    });
  });

  describe('web search subtitle', () => {
    it('shows "Web Search" in subtitle for models with web search capability', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const gptItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
      expect(gptItem).toHaveTextContent('Web Search');
    });

    it('does not show "Web Search" in subtitle for models without web search capability', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const llamaItem = screen.getByTestId('model-item-meta-llama/llama-3.1-70b-instruct');
      expect(llamaItem).not.toHaveTextContent('Web Search');
    });
  });

  describe('web search filter', () => {
    it('renders Web Search filter button', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getAllByRole('button', { name: /web search/i }).length).toBeGreaterThan(0);
    });

    it('filters to only web-search-capable models when active', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /web search/i })));

      expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
      expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
      expect(screen.queryByText('Llama 3.1 70B')).not.toBeInTheDocument();
    });
  });

  describe('Smart Model pin + details', () => {
    const smartModelEntry: Model = {
      id: 'smart-model',
      name: 'Smart Model',
      provider: 'HushBox',
      modality: 'text' as const,
      contextLength: 2_000_000,
      pricePerInputToken: 0.000_000_039,
      pricePerOutputToken: 0.000_000_19,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'Uses the best model for your task',
      supportedParameters: [],
      isSmartModel: true,
      minPricePerInputToken: 0.000_000_039,
      minPricePerOutputToken: 0.000_000_19,
      maxPricePerInputToken: 0.000_06,
      maxPricePerOutputToken: 0.000_18,
    };

    const modelsWithSmart: Model[] = [smartModelEntry, ...mockModels];

    it('pins Smart Model at the very top in default view', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Smart Model');
    });

    it('pins Smart Model to top when sort is active', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(first(screen.getAllByRole('button', { name: /price/i })));

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Smart Model');
    });

    it('pins Smart Model to top when search is active', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const searchInputs = screen.getAllByPlaceholderText('Search models');
      await user.type(first(searchInputs), 'GPT');

      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Smart Model');
    });

    it('shows price ranges instead of single prices in details panel', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Smart Model'));

      expect(screen.getByText('Input Price Range')).toBeInTheDocument();
      expect(screen.getByText('Output Price Range')).toBeInTheDocument();
    });

    it('shows "How it works" section in details panel', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByText('Smart Model'));

      expect(screen.getByText('How It Works')).toBeInTheDocument();
    });

    it('does not show expensive model warning for the Smart Model', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('hides Smart Model when activeModality is image', () => {
      const imageModel: Model = {
        ...smartModelEntry,
        id: 'google/imagen-4',
        name: 'Imagen 4',
        modality: 'image',
        provider: 'Google',
        isSmartModel: false,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0.04,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        contextLength: 0,
      };
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[smartModelEntry, imageModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="image"
        />
      );
      expect(screen.queryByText('Smart Model')).not.toBeInTheDocument();
    });

    it('hides Smart Model when activeModality is video', () => {
      const videoModel: Model = {
        ...smartModelEntry,
        id: 'google/veo-3.1',
        name: 'Veo 3.1',
        modality: 'video',
        provider: 'Google',
        isSmartModel: false,
        pricePerInputToken: 0,
        pricePerOutputToken: 0,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        contextLength: 0,
      };
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={[smartModelEntry, videoModel]}
          selectedIds={new Set()}
          onSelect={vi.fn()}
          activeModality="video"
        />
      );
      expect(screen.queryByText('Smart Model')).not.toBeInTheDocument();
    });

    it('shows subtitle in list item', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={modelsWithSmart}
          selectedIds={new Set(['smart-model'])}
          onSelect={vi.fn()}
        />
      );

      const smartModelItem = screen.getByTestId('model-item-smart-model');
      expect(smartModelItem).toHaveTextContent('Auto-picks the best model');
    });
  });

  describe('modal sizing', () => {
    it('uses dvh units for modal height', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const modal = screen.getByTestId('model-selector-modal');
      expect(modal.className).toMatch(/h-\[92dvh\]/);
      expect(modal.className).toMatch(/sm:h-\[85dvh\]/);
    });
  });

  describe('checkbox toggle', () => {
    it('renders a checkbox button for each model', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const checkboxes = screen.getAllByTestId('model-checkbox');
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it('toggles model selection when checkbox is clicked', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      // Click the checkbox on the unselected Claude model
      const claudeItem = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      const checkbox = claudeItem.querySelector('[data-testid="model-checkbox"]')!;
      await user.click(checkbox);

      // Verify Claude is now selected (aria-selected)
      expect(claudeItem).toHaveAttribute('data-selected', 'true');
    });
  });

  describe('footer buttons', () => {
    it('uses Title Case for single model button', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: 'Select Model' })).toBeInTheDocument();
    });

    it('uses Title Case for multi-model button', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      // Double-click Claude to add it
      await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

      expect(screen.getByRole('button', { name: 'Select 2 Models' })).toBeInTheDocument();
    });

    it('shows Clear Selected button when a single model is selected', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByTestId('clear-selection-button')).toBeInTheDocument();
      expect(screen.getByTestId('clear-selection-button')).toHaveTextContent('Clear Selected');
    });

    it('shows Clear Selected button when multiple models are selected', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

      expect(screen.getByTestId('clear-selection-button')).toBeInTheDocument();
      expect(screen.getByTestId('clear-selection-button')).toHaveTextContent('Clear Selected');
    });

    it('clears all selections so next toggle results in single model', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      // Select a second model
      await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));
      expect(screen.getByRole('button', { name: /Select 2 Models/i })).toBeInTheDocument();

      // Clear selection
      await user.click(screen.getByTestId('clear-selection-button'));

      // Now toggle Llama — should be the ONLY selected model
      await user.dblClick(screen.getByText('Llama 3.1 70B'));
      expect(screen.getByRole('button', { name: 'Select Model' })).toBeInTheDocument();
    });

    it('does not render selection counter', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

      expect(screen.queryByTestId('selection-counter')).not.toBeInTheDocument();
    });
  });

  describe('expensive model warning', () => {
    const expensiveModels: Model[] = [
      {
        id: 'cheap-model',
        name: 'Cheap Model',
        provider: 'Provider A',
        modality: 'text' as const,
        contextLength: 100_000,
        // $0.01/1k input + $0.03/1k output = $0.046/1k with fees (below $0.10 threshold)
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        description: 'A cheap model',
        supportedParameters: [],
      },
      {
        id: 'expensive-model',
        name: 'Expensive Model',
        provider: 'Provider B',
        modality: 'text' as const,
        contextLength: 200_000,
        // $0.05/1k input + $0.05/1k output = $0.115/1k with fees (above $0.10 threshold)
        pricePerInputToken: 0.000_05,
        pricePerOutputToken: 0.000_05,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
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
          selectedIds={new Set(['cheap-model'])}
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
          selectedIds={new Set(['cheap-model'])}
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
          selectedIds={new Set(['expensive-model'])}
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

  describe('deselecting last model', () => {
    it('allows deselecting the last model via checkbox toggle', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      const gptItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
      const checkbox = gptItem.querySelector('[data-testid="model-checkbox"]');
      expect(checkbox).not.toBeNull();
      await user.click(checkbox!);

      expect(gptItem).toHaveAttribute('data-selected', 'false');
    });

    it('shows Close as primary button text when no models are selected', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
        />
      );

      // Deselect the only model
      const gptItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
      const checkbox = gptItem.querySelector('[data-testid="model-checkbox"]');
      await user.click(checkbox!);

      // "Select Model" button should be gone, replaced by "Close"
      expect(screen.queryByRole('button', { name: 'Select Model' })).not.toBeInTheDocument();
      // Find all buttons with text "Close" — there's the modal X close (sr-only) and the footer one
      const closeButtons = screen.getAllByRole('button', { name: /^Close$/i });
      // At least one should be visible (the footer one)
      const visibleClose = closeButtons.find(
        (button) => !button.querySelector('.sr-only') && button.textContent === 'Close'
      );
      expect(visibleClose).toBeDefined();
    });

    it('Close primary button closes modal without calling onSelect', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={onOpenChange}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={onSelect}
        />
      );

      // Deselect the only model via Clear Selected
      await user.click(screen.getByTestId('clear-selection-button'));

      // Find the footer Close button (not the X button which has sr-only child)
      const closeButtons = screen.getAllByRole('button', { name: /^Close$/i });
      const footerClose = closeButtons.find(
        (button) => !button.querySelector('.sr-only') && button.textContent === 'Close'
      );
      expect(footerClose).toBeDefined();
      await user.click(footerClose!);

      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('multi-model gating', () => {
    it('shows signup modal for unauthenticated user selecting second non-premium model', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedIds={new Set(['openai/gpt-4-turbo'])}
          onSelect={vi.fn()}
          isAuthenticated={false}
        />
      );

      // Click checkbox on a different model
      const claudeItem = screen.getByTestId('model-item-anthropic/claude-3.5-sonnet');
      const checkbox = claudeItem.querySelector('[data-testid="model-checkbox"]');
      await user.click(checkbox!);

      expect(screen.getByTestId('multi-model-signup-modal')).toBeInTheDocument();
    });
  });
});
