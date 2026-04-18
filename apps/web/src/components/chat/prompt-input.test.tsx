import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PromptInput } from './prompt-input';
import type { ChatSearchProps, PromptInputRef } from './prompt-input';
import type { PromptBudgetResult } from '@/hooks/use-prompt-budget';

// Mock usePromptBudget directly — PromptInput's only budget dependency
const mockUsePromptBudget = vi.fn();

vi.mock('@/hooks/use-prompt-budget', () => ({
  usePromptBudget: (...args: unknown[]) => mockUsePromptBudget(...args),
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

// Mock StableContent — passthrough children when stable
vi.mock('@/components/shared/stable-content', () => ({
  StableContent: ({ isStable, children }: { isStable: boolean; children: React.ReactNode }) =>
    isStable ? children : null,
}));

// Default budget result — approved, no notifications, not over capacity
const defaultBudget: PromptBudgetResult = {
  fundingSource: 'personal_balance',
  notifications: [],
  capacityPercent: 5,
  capacityCurrentUsage: 1100,
  capacityMaxCapacity: 50_000,
  estimatedCostCents: 0.1,
  isOverCapacity: false,
  hasBlockingError: false,
  hasContent: true,
};

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

/**
 * Build a `searchProps` fixture for PromptInput tests. Defaults: modelSupportsSearch=true,
 * webSearchEnabled=false, onToggleWebSearch=vi.fn(). Override any field as needed.
 */
function makeSearchProps(overrides: Partial<ChatSearchProps> = {}): ChatSearchProps {
  return {
    modelSupportsSearch: true,
    webSearchEnabled: false,
    onToggleWebSearch: vi.fn(),
    ...overrides,
  };
}

describe('PromptInput', () => {
  const mockOnChange = vi.fn();
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: derive hasContent from input value
    mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
      ...defaultBudget,
      hasContent: input.value.trim().length > 0,
    }));
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
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 25,
        capacityCurrentUsage: 12_500,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByText(/Model \d+% filled/)).toBeInTheDocument();
    });

    it('send button is disabled when over capacity', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 105,
        isOverCapacity: true,
        hasBlockingError: true,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('send button is disabled when billing is denied', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          { id: 'insufficient_balance', type: 'error', message: 'Insufficient balance.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('textarea remains enabled even when over capacity', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 105,
        isOverCapacity: true,
        hasBlockingError: true,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });
  });

  describe('budget messages', () => {
    it('displays budget notifications when present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          { id: 'insufficient_balance', type: 'error', message: 'Insufficient balance.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByTestId('budget-messages')).toBeInTheDocument();
      expect(screen.getByText('Insufficient balance.')).toBeInTheDocument();
    });

    it('does not show budget messages when no notifications', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
    });

    it('shows warning messages', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
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
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_notice',
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
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_notice',
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
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_notice',
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

  describe('autoFocus prop', () => {
    it('applies autoFocus to textarea when autoFocus is true', async () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} autoFocus />
      );

      const textarea = screen.getByRole('textbox');
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(textarea);
      });
    });

    it('does not autoFocus textarea when autoFocus is false', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} autoFocus={false} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });

    it('does not autoFocus textarea when autoFocus is not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe('AI toggle', () => {
    it('does not show AI toggle when isGroupChat is not set', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /AI response/i })).not.toBeInTheDocument();
    });

    it('shows AI toggle when isGroupChat is true', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      expect(screen.getByRole('button', { name: /AI response on/i })).toBeInTheDocument();
    });

    it('defaults to AI ON', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      expect(screen.getByRole('button', { name: /AI response on/i })).toBeInTheDocument();
    });

    it('toggles to AI OFF when clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      const toggle = screen.getByRole('button', { name: /AI response on/i });
      await user.click(toggle);
      expect(screen.getByRole('button', { name: /AI response off/i })).toBeInTheDocument();
    });

    it('toggles back to AI ON on second click', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      const toggle = screen.getByRole('button', { name: /AI response on/i });
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /AI response off/i }));
      expect(screen.getByRole('button', { name: /AI response on/i })).toBeInTheDocument();
    });

    it('calls onSubmitUserOnly instead of onSubmit when AI is off', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      // Toggle AI off
      await user.click(screen.getByRole('button', { name: /AI response on/i }));
      // Submit
      await user.click(screen.getByRole('button', { name: /send/i }));
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('calls onSubmit when AI is on (default)', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      // AI is on by default, submit normally
      await user.click(screen.getByRole('button', { name: /send/i }));
      expect(mockOnSubmit).toHaveBeenCalled();
      expect(mockSubmitUserOnly).not.toHaveBeenCalled();
    });

    it('calls onSubmitUserOnly on Enter key when AI is off', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      // Toggle AI off
      await user.click(screen.getByRole('button', { name: /AI response on/i }));
      // Submit via Enter key
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('onTypingChange', () => {
    it('calls onTypingChange with true on first input change', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'H' } });
      expect(mockOnTypingChange).toHaveBeenCalledWith(true);
    });

    it('calls onTypingChange with false on submit', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('throttles onTypingChange calls within 3s window', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');

      // First change triggers immediately
      fireEvent.change(textarea, { target: { value: 'H' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(1);

      // Second change within 3s is throttled
      fireEvent.change(textarea, { target: { value: 'He' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(1);

      // After 3s, next change triggers again
      vi.advanceTimersByTime(3000);
      fireEvent.change(textarea, { target: { value: 'Hel' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(2);
    });

    it('calls onTypingChange with false when value becomes empty', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value="H"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');

      // Clear the input
      fireEvent.change(textarea, { target: { value: '' } });
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('calls onTypingChange with false on unmount', () => {
      const mockOnTypingChange = vi.fn();
      const { unmount } = renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );

      mockOnTypingChange.mockClear();
      unmount();
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('does not error when onTypingChange is not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      // Should not throw
      expect(() => {
        fireEvent.change(textarea, { target: { value: 'H' } });
      }).not.toThrow();
    });
  });

  describe('search toggle', () => {
    it('does not show search toggle by default', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /internet search/i })).not.toBeInTheDocument();
    });

    it('shows enabled search toggle when model supports search and user is authenticated', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps()}
        />
      );
      expect(screen.getByRole('button', { name: /internet search off/i })).toBeInTheDocument();
    });

    it('shows search on state when webSearchEnabled is true', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );
      expect(screen.getByRole('button', { name: /internet search on/i })).toBeInTheDocument();
    });

    it('calls onToggleWebSearch when clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockToggle = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ onToggleWebSearch: mockToggle })}
        />
      );
      await user.click(screen.getByRole('button', { name: /internet search off/i }));
      expect(mockToggle).toHaveBeenCalled();
    });

    it('shows disabled search toggle when model does not support search', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ modelSupportsSearch: false })}
        />
      );
      const button = screen.getByRole('button', { name: /internet search unavailable/i });
      expect(button).toBeDisabled();
    });

    it('shows disabled search toggle for unauthenticated users', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          searchProps={makeSearchProps()}
        />
      );
      const button = screen.getByRole('button', { name: /internet search unavailable/i });
      expect(button).toBeDisabled();
    });
  });

  describe('toggle button tooltips', () => {
    it('wraps disabled search toggle in span for tooltip accessibility', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          searchProps={makeSearchProps({ modelSupportsSearch: false })}
        />
      );

      const button = screen.getByRole('button', { name: /internet search unavailable/i });
      const wrapper = button.closest('span[data-slot="tooltip-trigger"]');
      expect(wrapper).not.toBeNull();
    });

    it('wraps enabled search toggle in span for tooltip consistency', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );

      const button = screen.getByRole('button', { name: /internet search on/i });
      const wrapper = button.closest('span[data-slot="tooltip-trigger"]');
      expect(wrapper).not.toBeNull();
    });

    it('wraps AI toggle in span for tooltip consistency', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );

      const button = screen.getByRole('button', { name: /AI response on/i });
      const wrapper = button.closest('span[data-slot="tooltip-trigger"]');
      expect(wrapper).not.toBeNull();
    });

    it('shows tooltip content when hovering search toggle', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );

      const button = screen.getByRole('button', { name: /internet search on/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Internet search on');
    });

    it('shows tooltip content when hovering AI toggle', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );

      const button = screen.getByRole('button', { name: /AI response on/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('AI response on');
    });

    it('updates search toggle tooltip text after state change', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      function SearchToggleHarness(): React.JSX.Element {
        const [searchOn, setSearchOn] = React.useState(false);
        return (
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            isAuthenticated
            searchProps={makeSearchProps({
              webSearchEnabled: searchOn,
              onToggleWebSearch: () => {
                setSearchOn((previous) => !previous);
              },
            })}
          />
        );
      }

      const queryClient = createTestQueryClient();
      render(
        <QueryClientProvider client={queryClient}>
          <SearchToggleHarness />
        </QueryClientProvider>
      );

      const button = screen.getByRole('button', { name: /internet search off/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Internet search off');

      // Click to toggle search on — tooltip should stay visible with updated text
      await user.click(button);

      expect(screen.getByRole('button', { name: /internet search on/i })).toBeInTheDocument();
      const updatedTooltip = screen.getByRole('tooltip');
      expect(updatedTooltip).toHaveTextContent('Internet search on');
    });
  });

  describe('edit mode', () => {
    it('shows editing indicator when isEditing is true', () => {
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      expect(screen.getByText(/editing/i)).toBeInTheDocument();
    });

    it('does not show editing indicator when isEditing is false', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByText(/editing/i)).not.toBeInTheDocument();
    });

    it('shows cancel button in edit mode', () => {
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('calls onCancelEdit when cancel button is clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const onCancelEdit = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={onCancelEdit}
        />
      );
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onCancelEdit).toHaveBeenCalledTimes(1);
    });

    it('does not show cancel button when not editing', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('privilege and conversationId forwarding to usePromptBudget', () => {
    it('passes currentUserPrivilege to usePromptBudget even without conversationId', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          currentUserPrivilege: 'read',
        })
      );
    });

    it('passes both conversationId and currentUserPrivilege to usePromptBudget', () => {
      mockUsePromptBudget.mockReturnValue(defaultBudget);

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          conversationId="conv-123"
          currentUserPrivilege="write"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-123',
          currentUserPrivilege: 'write',
        })
      );
    });

    it('passes conversationId without currentUserPrivilege to usePromptBudget', () => {
      mockUsePromptBudget.mockReturnValue(defaultBudget);

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          conversationId="conv-123"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-123',
        })
      );
      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.not.objectContaining({
          currentUserPrivilege: expect.anything(),
        })
      );
    });
  });

  describe('read-only privilege', () => {
    it('send button is disabled when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('read-only notification renders when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      expect(
        screen.getByText('You have read-only access to this conversation.')
      ).toBeInTheDocument();
    });

    it('Enter key does not submit when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('blocking errors', () => {
    it('send button is disabled when blocking error present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        notifications: [
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
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        notifications: [
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

  describe('modality toggle', () => {
    it('does not render the modality toggle when isAuthenticated is undefined', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="text"
          onToggleModality={vi.fn()}
        />
      );
      expect(
        screen.queryByRole('button', { name: /switch to (image generation|text)/i })
      ).not.toBeInTheDocument();
    });

    it('does not render the modality toggle for unauthenticated users', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          activeModality="text"
          onToggleModality={vi.fn()}
        />
      );
      expect(
        screen.queryByRole('button', { name: /switch to (image generation|text)/i })
      ).not.toBeInTheDocument();
    });

    it('renders the image-generation toggle for authenticated users in text mode', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onToggleModality={vi.fn()}
        />
      );
      expect(
        screen.getByRole('button', { name: /switch to image generation/i })
      ).toBeInTheDocument();
    });

    it('renders the text-switch toggle for authenticated users in image mode', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
          onToggleModality={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /switch to text/i })).toBeInTheDocument();
    });

    it('invokes onToggleModality when clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const handleToggle = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onToggleModality={handleToggle}
        />
      );
      await user.click(screen.getByRole('button', { name: /switch to image generation/i }));
      expect(handleToggle).toHaveBeenCalled();
    });
  });
});
