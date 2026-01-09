import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import * as React from 'react';
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
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders all messages', () => {
    render(<MessageList messages={messages} />);

    // All messages render immediately (no typing effect)
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

  it('passes streamingMessageId to mark streaming message', () => {
    render(<MessageList messages={messages} streamingMessageId="2" />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
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

  describe('document extraction', () => {
    it('calls onDocumentsExtracted when assistant message has documents', () => {
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

      // Let any async effects complete
      act(() => {
        vi.runAllTimers();
      });

      expect(onDocumentsExtracted).toHaveBeenCalled();

      const [messageId, docs] = onDocumentsExtracted.mock.calls[0] as [string, unknown[]];
      expect(messageId).toBe('msg-with-code');
      expect(docs).toHaveLength(1);
    });
  });

  describe('scroll support', () => {
    it('exposes viewport element via viewportRef', () => {
      const viewportRef = React.createRef<HTMLDivElement>();
      render(<MessageList messages={messages} viewportRef={viewportRef} />);

      expect(viewportRef.current).toBeInstanceOf(HTMLDivElement);
      expect(viewportRef.current).toHaveAttribute('data-slot', 'scroll-area-viewport');
    });

    it('calls onScroll when viewport is scrolled', () => {
      const handleScroll = vi.fn();
      render(<MessageList messages={messages} onScroll={handleScroll} />);

      const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
      if (!viewport) throw new Error('Viewport not found');
      fireEvent.scroll(viewport);

      expect(handleScroll).toHaveBeenCalledTimes(1);
    });
  });
});
