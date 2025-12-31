import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromptInput } from './prompt-input';

describe('PromptInput', () => {
  const mockOnChange = vi.fn();
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a textarea', () => {
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('displays placeholder text', () => {
    render(
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
    render(<PromptInput value="Hello world" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('textbox')).toHaveValue('Hello world');
  });

  it('calls onChange when typing', async () => {
    const user = userEvent.setup();
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Test');
    expect(mockOnChange).toHaveBeenCalled();
  });

  it('calls onSubmit when Enter is pressed without Shift', () => {
    render(<PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('does not call onSubmit when Shift+Enter is pressed (allows newline)', () => {
    render(<PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('has send button', () => {
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('send button calls onSubmit when clicked', async () => {
    const user = userEvent.setup();
    render(<PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('send button is disabled when value is empty', () => {
    render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  describe('token counter', () => {
    it('displays token counter with current/max format', () => {
      // "Hello" = 5 chars ≈ 2 tokens (5/4 rounded up)
      // Using modelContextLimit: 3000, historyTokens: 0, buffer: 1000, base system prompt: ~37 tokens
      // available ≈ 3000 - 0 - 37 - 1000 = 1963
      render(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          modelContextLimit={3000}
          historyTokens={0}
        />
      );
      // Token counter shows current/available format
      expect(screen.getByTestId('token-counter')).toHaveTextContent(/2\/\d+ Tokens/);
    });

    it('shows over-limit format when exceeding available tokens', () => {
      // 8000+ chars = 2000+ tokens, which exceeds available (~1963)
      const longText = 'a'.repeat(8020); // ~2005 tokens
      render(
        <PromptInput
          value={longText}
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          modelContextLimit={3000}
          historyTokens={0}
        />
      );
      // Should show format like "1963+42/1963 Tokens"
      expect(screen.getByTestId('token-counter')).toHaveTextContent(/\d+\+\d+\/\d+ Tokens/);
    });

    it('shows warning message when over token limit', () => {
      const longText = 'a'.repeat(8020); // ~2005 tokens
      render(
        <PromptInput
          value={longText}
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          modelContextLimit={3000}
          historyTokens={0}
        />
      );
      expect(
        screen.getByText(/tokens beyond the \d+ token limit will not be included/i)
      ).toBeInTheDocument();
    });

    it('send button is disabled when over token limit', () => {
      // Using modelContextLimit: 3000, historyTokens: 0, buffer: 1000 → available: 2000
      const longText = 'a'.repeat(8020); // ~2005 tokens
      render(
        <PromptInput
          value={longText}
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          modelContextLimit={3000}
          historyTokens={0}
        />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('uses default of 2000 tokens when modelContextLimit is not provided', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      expect(screen.getByTestId('token-counter')).toHaveTextContent('2/2000 Tokens');
    });

    it('token counter has aria-live for screen reader announcements', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const counter = screen.getByTestId('token-counter');
      expect(counter).toHaveAttribute('aria-live', 'polite');
    });

    it('token counter has aria-atomic for complete announcements', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const counter = screen.getByTestId('token-counter');
      expect(counter).toHaveAttribute('aria-atomic', 'true');
    });

    it('calculates available tokens from modelContextLimit minus historyTokens minus systemPrompt minus buffer', () => {
      // modelContextLimit: 50000, historyTokens: 5000, base system prompt: ~37, buffer: 1000
      // available ≈ 50000 - 5000 - 37 - 1000 = 43963
      render(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          modelContextLimit={50000}
          historyTokens={5000}
        />
      );
      const counter = screen.getByTestId('token-counter');
      expect(counter).toHaveTextContent(/2\/\d+ Tokens/);
      // Should be less than 44000 (which was without system prompt)
      const match = /\/(\d+) Tokens/.exec(counter.textContent);
      const available = match?.[1] ? parseInt(match[1], 10) : 0;
      expect(available).toBeLessThan(44000);
      expect(available).toBeGreaterThan(43900);
    });

    it('uses default 2000 tokens when modelContextLimit is not provided', () => {
      render(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          historyTokens={0}
        />
      );
      expect(screen.getByTestId('token-counter')).toHaveTextContent('2/2000 Tokens');
    });

    it('caps available tokens at 0 when history exceeds context limit', () => {
      // modelContextLimit: 5000, historyTokens: 4500, system prompt: ~37, buffer: 1000
      // available = 5000 - 4500 - 37 - 1000 = -537 -> capped at 0
      render(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          modelContextLimit={5000}
          historyTokens={4500}
        />
      );
      expect(screen.getByTestId('token-counter')).toHaveTextContent('/0 Tokens');
    });

    it('defaults historyTokens to 0 when not provided', () => {
      // modelContextLimit: 50000, base system prompt: ~37, buffer: 1000
      // available ≈ 50000 - 0 - 37 - 1000 = 48963
      render(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          modelContextLimit={50000}
        />
      );
      const counter = screen.getByTestId('token-counter');
      expect(counter).toHaveTextContent(/2\/\d+ Tokens/);
      // Should be less than 49000 (which was without system prompt)
      const match = /\/(\d+) Tokens/.exec(counter.textContent);
      const available = match?.[1] ? parseInt(match[1], 10) : 0;
      expect(available).toBeLessThan(49000);
      expect(available).toBeGreaterThan(48900);
    });

    describe('system prompt tokens', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-15'));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('subtracts system prompt tokens from available tokens with no capabilities', () => {
        // Base system prompt is ~90 chars = ~23 tokens
        // modelContextLimit: 50000, historyTokens: 0, systemPrompt: ~23, buffer: 1000
        // available = 50000 - 0 - 23 - 1000 = 48977
        render(
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            modelContextLimit={50000}
            historyTokens={0}
            capabilities={[]}
          />
        );
        const counter = screen.getByTestId('token-counter');
        // Should be less than 49000 (which is without system prompt)
        expect(counter.textContent).toMatch(/2\/\d+ Tokens/);
        // Extract the available tokens number and verify it's less than 49000
        const match = /\/(\d+) Tokens/.exec(counter.textContent);
        const available = match?.[1] ? parseInt(match[1], 10) : 0;
        expect(available).toBeLessThan(49000);
        expect(available).toBeGreaterThan(48900); // Should be around 48977
      });

      it('subtracts more tokens when python capability is enabled', () => {
        // Python adds ~265 chars = ~67 tokens on top of base
        // Total system prompt = ~90 + 265 = ~355 chars = ~89 tokens
        render(
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            modelContextLimit={50000}
            historyTokens={0}
            capabilities={['python-execution']}
          />
        );
        const counter = screen.getByTestId('token-counter');
        const match = /\/(\d+) Tokens/.exec(counter.textContent);
        const available = match?.[1] ? parseInt(match[1], 10) : 0;
        // With python: ~89 tokens subtracted, so available ≈ 48911
        expect(available).toBeLessThan(48950);
        expect(available).toBeGreaterThan(48850);
      });

      it('subtracts tokens for multiple capabilities', () => {
        // Python + JS adds ~530 chars = ~133 tokens on top of base
        render(
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            modelContextLimit={50000}
            historyTokens={0}
            capabilities={['python-execution', 'javascript-execution']}
          />
        );
        const counter = screen.getByTestId('token-counter');
        const match = /\/(\d+) Tokens/.exec(counter.textContent);
        const available = match?.[1] ? parseInt(match[1], 10) : 0;
        // With both: ~156 tokens subtracted, so available ≈ 48844
        expect(available).toBeLessThan(48900);
        expect(available).toBeGreaterThan(48750);
      });
    });
  });

  describe('custom height props', () => {
    it('applies custom minHeight when provided', () => {
      render(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} minHeight="56px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('min-h-[56px]');
    });

    it('applies custom maxHeight when provided', () => {
      render(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} maxHeight="112px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('max-h-[112px]');
    });

    it('uses default minHeight when not provided', () => {
      render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('min-h-[120px]');
    });

    it('uses default maxHeight when not provided', () => {
      render(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveClass('max-h-[40vh]');
    });
  });

  describe('streaming mode', () => {
    const mockOnStop = vi.fn();

    beforeEach(() => {
      mockOnStop.mockClear();
    });

    it('shows stop button instead of send button when streaming', () => {
      render(
        <PromptInput
          value="Test"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isStreaming
          onStop={mockOnStop}
        />
      );
      expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
    });

    it('calls onStop when stop button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <PromptInput
          value="Test"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isStreaming
          onStop={mockOnStop}
        />
      );
      await user.click(screen.getByRole('button', { name: /stop/i }));
      expect(mockOnStop).toHaveBeenCalled();
    });

    it('disables textarea while streaming', () => {
      render(
        <PromptInput
          value="Test"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isStreaming
          onStop={mockOnStop}
        />
      );
      expect(screen.getByRole('textbox')).toBeDisabled();
    });
  });
});
