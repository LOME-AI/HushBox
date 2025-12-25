import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('displays character counter', () => {
    render(
      <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} maxLength={2000} />
    );
    expect(screen.getByTestId('character-counter')).toHaveTextContent('5/2000');
  });

  it('shows over-limit styling when exceeding maxLength', () => {
    const longText = 'a'.repeat(2005);
    render(
      <PromptInput
        value={longText}
        onChange={mockOnChange}
        onSubmit={mockOnSubmit}
        maxLength={2000}
      />
    );
    expect(screen.getByTestId('character-counter')).toHaveTextContent('2000+5/2000');
  });

  it('shows warning message when over limit', () => {
    const longText = 'a'.repeat(2005);
    render(
      <PromptInput
        value={longText}
        onChange={mockOnChange}
        onSubmit={mockOnSubmit}
        maxLength={2000}
      />
    );
    expect(screen.getByText(/will not be included/i)).toBeInTheDocument();
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

  it('send button is disabled when over limit', () => {
    const longText = 'a'.repeat(2005);
    render(
      <PromptInput
        value={longText}
        onChange={mockOnChange}
        onSubmit={mockOnSubmit}
        maxLength={2000}
      />
    );
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  describe('accessibility', () => {
    it('character counter has aria-live for screen reader announcements', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const counter = screen.getByTestId('character-counter');
      expect(counter).toHaveAttribute('aria-live', 'polite');
    });

    it('character counter has aria-atomic for complete announcements', () => {
      render(<PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const counter = screen.getByTestId('character-counter');
      expect(counter).toHaveAttribute('aria-atomic', 'true');
    });
  });
});
