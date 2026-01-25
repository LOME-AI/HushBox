import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PromptInput } from './prompt-input';
import type { PromptInputRef } from './prompt-input';
import type { BudgetCalculationResult } from '@lome-chat/shared';

// Mock the hooks used by PromptInput
vi.mock('@/stores/model', () => ({
  useModelStore: vi.fn(() => ({
    selectedModelId: 'test-model',
  })),
}));

vi.mock('@/hooks/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models')>();
  return {
    ...actual,
    useModels: vi.fn(() => ({
      data: {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            contextLength: 50_000,
            pricePerInputToken: 0.000_001,
            pricePerOutputToken: 0.000_002,
          },
        ],
      },
      isLoading: false,
      error: null,
    })),
  };
});

// Default session mock value
const defaultSession: { data: { user: { id: string; email: string } } | null; isPending: boolean } =
  {
    data: { user: { id: 'test-user', email: 'test@example.com' } },
    isPending: false,
  };

const mockUseSession = vi.fn(() => defaultSession);

vi.mock('@/lib/auth', () => ({
  useSession: () => mockUseSession(),
}));

// Default budget result - can afford, no errors, not loading
const defaultBudgetResult: BudgetCalculationResult & { isBalanceLoading: boolean } = {
  canAfford: true,
  maxOutputTokens: 1000,
  estimatedInputTokens: 100,
  estimatedInputCost: 0.0001,
  estimatedMinimumCost: 0.001,
  effectiveBalance: 1,
  currentUsage: 1100,
  capacityPercent: 5,
  errors: [],
  isBalanceLoading: false,
};

// Mock useBudgetCalculation with customizable return value
const mockBudgetResult = vi.fn(() => defaultBudgetResult);

vi.mock('@/hooks/use-budget-calculation', () => ({
  useBudgetCalculation: () => mockBudgetResult(),
}));

// Mock stability hooks - configurable via mockUseStability
const defaultStabilityState = {
  isAuthStable: true,
  isBalanceStable: true,
  isAppStable: true,
};
const mockUseStability = vi.fn(() => defaultStabilityState);

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => mockUseStability(),
}));

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  const queryClient = createTestQueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('PromptInput', () => {
  const mockOnChange = vi.fn();
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockBudgetResult.mockReturnValue(defaultBudgetResult);
    mockUseSession.mockReturnValue(defaultSession);
    mockUseStability.mockReturnValue(defaultStabilityState);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a textarea', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('displays placeholder text', () => {
    renderWithProviders(
      <PromptInput
        value=""
        onChange={mockOnChange}
        onSubmit={mockOnSubmit}
        placeholder="Ask me anything..."
      />
    );
    expect(screen.getByPlaceholderText('Ask me anything...')).toBeInTheDocument();
  });

  it('displays the current value', () => {
    renderWithProviders(
      <PromptInput value="Hello world" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    expect(screen.getByRole('textbox')).toHaveValue('Hello world');
  });

  it('calls onChange when typing', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Test');
    expect(mockOnChange).toHaveBeenCalled();
  });

  it('calls onSubmit when Enter is pressed without Shift', () => {
    renderWithProviders(
      <PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('does not call onSubmit when Shift+Enter is pressed (allows newline)', () => {
    renderWithProviders(
      <PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('has send button', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('send button calls onSubmit when clicked', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderWithProviders(
      <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('send button is disabled when value is empty', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  describe('capacity bar', () => {
    it('displays capacity bar', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });

    it('shows capacity percentage', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        capacityPercent: 25,
        currentUsage: 12_500,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByText(/Model \d+% filled/)).toBeInTheDocument();
    });

    it('send button is disabled when over capacity', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        capacityPercent: 105,
        canAfford: true,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('send button is disabled when cannot afford', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        canAfford: false,
        errors: [
          { id: 'insufficient_guest', type: 'error', message: 'Message exceeds guest limits.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('textarea remains enabled even when over capacity', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        capacityPercent: 105,
        canAfford: false,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });
  });

  describe('budget messages', () => {
    it('displays budget errors when present', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        canAfford: false,
        errors: [
          { id: 'insufficient_guest', type: 'error', message: 'Message exceeds guest limits.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByTestId('budget-messages')).toBeInTheDocument();
      expect(screen.getByText('Message exceeds guest limits.')).toBeInTheDocument();
    });

    it('does not show budget messages when no errors', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        errors: [],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
    });

    it('shows warning messages', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        errors: [
          {
            id: 'capacity_warning',
            type: 'warning',
            message: "Your conversation is near this model's memory limit.",
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(
        screen.getByText("Your conversation is near this model's memory limit.")
      ).toBeInTheDocument();
    });

    it('shows info messages', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        errors: [
          {
            id: 'guest_notice',
            type: 'info',
            message: 'Free preview. Sign up for full access.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByText('Free preview. Sign up for full access.')).toBeInTheDocument();
    });

    it('hides budget messages while app is not stable (balance loading)', () => {
      // App is not stable (isAppStable: false)
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        isBalanceLoading: true,
        errors: [
          {
            id: 'guest_notice',
            type: 'info',
            message: 'Free preview. Sign up for full access.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      // Budget messages should be hidden while app is not stable
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
      expect(screen.queryByText('Free preview. Sign up for full access.')).not.toBeInTheDocument();
    });

    it('hides budget messages while app is not stable (session loading)', () => {
      // Session is loading - stability reflects this
      mockUseStability.mockReturnValue({
        isAuthStable: false,
        isBalanceStable: true,
        isAppStable: false,
      });
      mockUseSession.mockReturnValue({
        data: null,
        isPending: true,
      });
      // Budget calculation returns guest errors because session appears unauthenticated
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        isBalanceLoading: false,
        errors: [
          {
            id: 'guest_notice',
            type: 'info',
            message: 'Free preview. Sign up for full access.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      // Budget messages should be hidden while app is not stable
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
      expect(screen.queryByText('Free preview. Sign up for full access.')).not.toBeInTheDocument();
    });
  });

  describe('self-contained budget calculation', () => {
    it('accepts historyCharacters prop for budget calculation', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          historyCharacters={5000}
        />
      );
      // Component should render without error
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });

    it('accepts capabilities prop for system prompt calculation', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          capabilities={['web-search']}
        />
      );
      // Component should render without error
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });
  });

  describe('custom height props', () => {
    it('applies custom minHeight when provided', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} minHeight="56px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('min-h-[56px]');
    });

    it('applies custom maxHeight when provided', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} maxHeight="112px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('max-h-[112px]');
    });

    it('uses default minHeight when not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('min-h-[120px]');
    });

    it('uses default maxHeight when not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('max-h-[40vh]');
    });
  });

  describe('processing mode', () => {
    it('shows stop icon and disables button when processing', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      const button = screen.getByRole('button', { name: /cannot send/i });
      expect(button).toBeDisabled();
      // Button contains Square icon (stop), not Send icon
      expect(button.querySelector('svg')).toBeInTheDocument();
    });

    it('keeps textarea enabled during processing for type-ahead', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });

    it('shows send icon when not processing and can submit', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const button = screen.getByRole('button', { name: /send/i });
      expect(button).not.toBeDisabled();
    });
  });

  describe('ref and focus', () => {
    it('exposes focus method via ref', () => {
      const ref = React.createRef<PromptInputRef>();
      renderWithProviders(
        <PromptInput ref={ref} value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current?.focus).toBe('function');
    });

    it('focuses textarea when focus() is called', () => {
      const ref = React.createRef<PromptInputRef>();
      renderWithProviders(
        <PromptInput ref={ref} value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);

      ref.current?.focus();

      expect(document.activeElement).toBe(textarea);
    });

    it('does not auto-focus when initially enabled (not a transition)', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled={false} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });

    it('does not auto-focus when transitioning from enabled to disabled', () => {
      const { rerender } = renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled={false} />
      );

      const textarea = screen.getByRole('textbox');

      rerender(
        <QueryClientProvider client={createTestQueryClient()}>
          <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled />
        </QueryClientProvider>
      );

      expect(textarea).toBeDisabled();
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe('blocking errors', () => {
    it('send button is disabled when blocking error present', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        canAfford: true,
        errors: [
          {
            id: 'capacity_exceeded',
            type: 'error',
            message: 'Message exceeds model capacity.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('Enter key does not submit when blocking error present', () => {
      mockBudgetResult.mockReturnValue({
        ...defaultBudgetResult,
        canAfford: true,
        errors: [
          {
            id: 'capacity_exceeded',
            type: 'error',
            message: 'Message exceeds model capacity.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });
});
