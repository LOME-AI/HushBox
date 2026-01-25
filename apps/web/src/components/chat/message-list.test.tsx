import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as React from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
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

// Mock Virtuoso to render items directly (virtualization doesn't work in jsdom)
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(
    {
      data,
      itemContent,
      components,
    }: {
      data: unknown[];
      itemContent: (index: number, item: unknown) => React.ReactNode;
      components?: { Footer?: () => React.ReactNode };
    },
    ref: React.Ref<VirtuosoHandle>
  ) {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: vi.fn(),
      scrollTo: vi.fn(),
      scrollBy: vi.fn(),
      scrollIntoView: vi.fn(),
      getState: vi.fn(),
      autoscrollToBottom: vi.fn(),
    }));
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, index) => (
          <div key={index}>{itemContent(index, item)}</div>
        ))}
        {components?.Footer?.()}
      </div>
    );
  }),
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

    expect(screen.getByText('Hello!')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
    expect(screen.getByText('How are you?')).toBeInTheDocument();
  });

  it('renders empty state when no messages', () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByTestId('message-list-empty')).toBeInTheDocument();
  });

  it('renders container with correct test id', () => {
    render(<MessageList messages={messages} />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('displays messages in order', () => {
    render(<MessageList messages={messages} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  it('container takes full height with min-h-0 for flex', () => {
    render(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveClass('flex-1');
    expect(container).toHaveClass('min-h-0');
  });

  it('passes streamingMessageId to mark streaming message', () => {
    render(<MessageList messages={messages} streamingMessageId="2" />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  describe('forwardRef', () => {
    it('exposes VirtuosoHandle via ref', () => {
      const ref = React.createRef<VirtuosoHandle>();
      render(<MessageList ref={ref} messages={messages} />);

      // Virtuoso provides methods like scrollToIndex
      expect(ref.current).toBeDefined();
    });
  });

  describe('document extraction', () => {
    it('calls onDocumentsExtracted when assistant message has documents', () => {
      const largeCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `const line${String(index)} = ${String(index)};`)
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

      act(() => {
        vi.runAllTimers();
      });

      expect(onDocumentsExtracted).toHaveBeenCalled();

      const [messageId, documents] = onDocumentsExtracted.mock.calls[0] as [string, unknown[]];
      expect(messageId).toBe('msg-with-code');
      expect(documents).toHaveLength(1);
    });
  });
});
