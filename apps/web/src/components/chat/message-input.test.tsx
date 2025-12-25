import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageInput } from './message-input';

describe('MessageInput', () => {
  const mockOnSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders textarea', () => {
    render(<MessageInput onSend={mockOnSend} />);
    expect(screen.getByPlaceholderText(/message/i)).toBeInTheDocument();
  });

  it('renders send button', () => {
    render(<MessageInput onSend={mockOnSend} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('calls onSend with message when send button clicked', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello AI');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(mockOnSend).toHaveBeenCalledWith('Hello AI');
  });

  it('clears textarea after sending', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello AI');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(textarea).toHaveValue('');
  });

  it('disables send button when textarea is empty', () => {
    render(<MessageInput onSend={mockOnSend} />);
    const sendButton = screen.getByRole('button', { name: /send/i });
    expect(sendButton).toBeDisabled();
  });

  it('enables send button when textarea has content', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello');

    const sendButton = screen.getByRole('button', { name: /send/i });
    expect(sendButton).not.toBeDisabled();
  });

  it('sends message on Enter key (without Shift)', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello AI{Enter}');

    expect(mockOnSend).toHaveBeenCalledWith('Hello AI');
  });

  it('does not send on Shift+Enter (allows newline)', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={mockOnSend} />);

    const textarea = screen.getByPlaceholderText(/message/i);
    await user.type(textarea, 'Hello{Shift>}{Enter}{/Shift}World');

    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it('shows disabled state when disabled prop is true', () => {
    render(<MessageInput onSend={mockOnSend} disabled />);
    const textarea = screen.getByPlaceholderText(/message/i);
    expect(textarea).toBeDisabled();
  });
});
