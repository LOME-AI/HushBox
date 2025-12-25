import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './message-list';

describe('MessageList', () => {
  const messages = [
    {
      id: '1',
      conversationId: 'conv-1',
      role: 'user' as const,
      content: 'Hello!',
      createdAt: '2024-01-01T00:00:00Z',
    },
    {
      id: '2',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: 'Hi there!',
      createdAt: '2024-01-01T00:00:01Z',
    },
    {
      id: '3',
      conversationId: 'conv-1',
      role: 'user' as const,
      content: 'How are you?',
      createdAt: '2024-01-01T00:00:02Z',
    },
  ];

  it('renders all messages', () => {
    render(<MessageList messages={messages} />);
    expect(screen.getByText('Hello!')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
    expect(screen.getByText('How are you?')).toBeInTheDocument();
  });

  it('renders empty state when no messages', () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByTestId('message-list-empty')).toBeInTheDocument();
  });

  it('uses ScrollArea for scrollable content', () => {
    render(<MessageList messages={messages} />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('displays messages in order', () => {
    render(<MessageList messages={messages} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  it('takes full height', () => {
    render(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveClass('flex-1');
  });

  describe('accessibility', () => {
    it('has role="log" on messages container', () => {
      render(<MessageList messages={messages} />);
      expect(screen.getByRole('log')).toBeInTheDocument();
    });

    it('has aria-live="polite" for screen reader announcements', () => {
      render(<MessageList messages={messages} />);
      const log = screen.getByRole('log');
      expect(log).toHaveAttribute('aria-live', 'polite');
    });

    it('has aria-label for messages container', () => {
      render(<MessageList messages={messages} />);
      const log = screen.getByRole('log');
      expect(log).toHaveAttribute('aria-label', 'Chat messages');
    });
  });
});
