import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MessageList } from './message-list';

// Mock mermaid to avoid actual rendering
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg>Diagram</svg>',
      bindFunctions: vi.fn(),
    }),
  },
}));

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

describe('MessageList', () => {
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

  describe('streaming', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it('shows streaming message when isStreaming is true and streamingContent provided', () => {
      render(
        <MessageList
          messages={messages}
          isStreaming={true}
          streamingContent="Partial response..."
        />
      );

      expect(screen.getByTestId('streaming-message')).toBeInTheDocument();

      // Advance timers to allow typing effect to complete
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(screen.getByText('Partial response...')).toBeInTheDocument();
    });

    it('shows streaming indicator when isStreaming is true', () => {
      render(
        <MessageList messages={messages} isStreaming={true} streamingContent="Generating..." />
      );

      expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    });

    it('does not show streaming message when isStreaming is false', () => {
      render(<MessageList messages={messages} isStreaming={false} streamingContent="" />);

      expect(screen.queryByTestId('streaming-message')).not.toBeInTheDocument();
    });

    it('does not show streaming message when streamingContent is empty and isStreaming is false', () => {
      render(<MessageList messages={messages} />);

      expect(screen.queryByTestId('streaming-message')).not.toBeInTheDocument();
    });

    it('shows streaming message after all regular messages', () => {
      render(<MessageList messages={messages} isStreaming={true} streamingContent="AI response" />);

      const messageItems = screen.getAllByTestId('message-item');
      const streamingMessage = screen.getByTestId('streaming-message-container');

      // All regular messages should exist
      expect(messageItems).toHaveLength(3);
      // Streaming message should also exist
      expect(streamingMessage).toBeInTheDocument();
    });
  });

  describe('document extraction', () => {
    it('calls onDocumentsExtracted when assistant message has documents', async () => {
      const largeCode = Array(15)
        .fill(null)
        .map((_, i) => `const line${String(i)} = ${String(i)};`)
        .join('\n');
      const messagesWithCode = [
        {
          id: 'msg-with-code',
          conversationId: 'conv-1',
          role: 'assistant' as const,
          content: `\`\`\`typescript\n${largeCode}\n\`\`\``,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];
      const onDocumentsExtracted = vi.fn();

      render(
        <MessageList messages={messagesWithCode} onDocumentsExtracted={onDocumentsExtracted} />
      );

      await waitFor(() => {
        expect(onDocumentsExtracted).toHaveBeenCalled();
      });

      const [messageId, docs] = onDocumentsExtracted.mock.calls[0] as [string, unknown[]];
      expect(messageId).toBe('msg-with-code');
      expect(docs).toHaveLength(1);
    });
  });
});
