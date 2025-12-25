import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageItem } from './message-item';

describe('MessageItem', () => {
  const userMessage = {
    id: '1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'Hello, how are you?',
    createdAt: '2024-01-01T00:00:00Z',
  };

  const assistantMessage = {
    id: '2',
    conversationId: 'conv-1',
    role: 'assistant' as const,
    content: 'I am doing well, thank you!',
    createdAt: '2024-01-01T00:00:01Z',
  };

  it('renders message content', () => {
    render(<MessageItem message={userMessage} />);
    expect(screen.getByText('Hello, how are you?')).toBeInTheDocument();
  });

  it('renders user message with user styling', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'user');
  });

  it('renders assistant message with assistant styling', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'assistant');
  });

  it('displays avatar for assistant messages', () => {
    render(<MessageItem message={assistantMessage} />);
    expect(screen.getByTestId('assistant-avatar')).toBeInTheDocument();
  });

  it('displays avatar for user messages', () => {
    render(<MessageItem message={userMessage} />);
    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('aligns user messages to the right', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('justify-end');
  });

  it('aligns assistant messages to the left', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('justify-start');
  });

  it('renders with proper gap and padding', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('gap-3');
    expect(container).toHaveClass('px-4');
  });
});
