import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { MessageList, type MessageListHandle } from './message-list';
import type { Message } from '@/lib/api';

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

vi.mock('@/hooks/models', () => ({
  useModels: () => ({
    data: { models: [], premiumIds: new Set() },
    isLoading: false,
  }),
}));

// Capture Virtuoso props for scroll behavior testing
let capturedVirtuosoProps: Record<string, unknown> = {};

// Mock Virtuoso to render items directly (virtualization doesn't work in jsdom)
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(
    props: Record<string, unknown>,
    ref: React.Ref<VirtuosoHandle>
  ) {
    Object.assign(capturedVirtuosoProps, props);
    const data = props['data'] as unknown[];
    const itemContent = props['itemContent'] as (index: number, item: unknown) => React.ReactNode;
    const components = props['components'] as { Footer?: () => React.ReactNode } | undefined;
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

  it('renders role="log" on empty state so waitForConversationLoaded works', () => {
    render(<MessageList messages={[]} />);
    const emptyState = screen.getByTestId('message-list-empty');
    expect(emptyState).toHaveAttribute('role', 'log');
    expect(emptyState).toHaveAttribute('aria-label', 'Chat messages');
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

  it('passes streamingMessageIds to mark streaming message', () => {
    render(<MessageList messages={messages} streamingMessageIds={new Set(['2'])} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  describe('forwardRef', () => {
    it('exposes MessageListHandle via ref', () => {
      const ref = React.createRef<MessageListHandle>();
      render(<MessageList ref={ref} messages={messages} />);

      // MessageListHandle extends VirtuosoHandle with additional methods
      expect(ref.current).toBeDefined();
    });
  });

  describe('error message identification', () => {
    it('passes isError to MessageItem when errorMessageId matches', () => {
      const errorMessages = [
        {
          id: 'err-1',
          conversationId: 'conv-1',
          role: 'assistant' as const,
          content: 'You ran out of messages. [Sign up](/signup) to continue!',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];
      render(<MessageList messages={errorMessages} errorMessageId="err-1" />);

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveAttribute('data-error', 'true');
    });

    it('does not pass isError when errorMessageId does not match', () => {
      render(<MessageList messages={messages} errorMessageId="nonexistent" />);

      const messageItems = screen.getAllByTestId('message-item');
      for (const item of messageItems) {
        expect(item).not.toHaveAttribute('data-error');
      }
    });
  });

  describe('onShare', () => {
    it('passes onShare to assistant message items', () => {
      const onShare = vi.fn();
      render(<MessageList messages={messages} onShare={onShare} />);

      const shareButtons = screen.getAllByLabelText('Share');
      expect(shareButtons).toHaveLength(1);
    });

    it('does not render share buttons when onShare is not provided', () => {
      render(<MessageList messages={messages} />);

      expect(screen.queryByLabelText('Share')).not.toBeInTheDocument();
    });
  });

  describe('action callbacks', () => {
    it('passes onRegenerate to MessageItem so retry button renders on user messages', () => {
      const onRegenerate = vi.fn();
      render(<MessageList messages={messages} onRegenerate={onRegenerate} />);

      // User messages should have a "Retry" button when onRegenerate is provided
      const retryButtons = screen.getAllByLabelText('Retry');
      expect(retryButtons.length).toBeGreaterThan(0);
    });

    it('passes onEdit to MessageItem so edit button renders on user messages', () => {
      const onEdit = vi.fn();
      render(<MessageList messages={messages} onEdit={onEdit} />);

      const editButtons = screen.getAllByLabelText('Edit');
      expect(editButtons.length).toBeGreaterThan(0);
    });

    it('passes onFork to MessageItem so fork button renders', () => {
      const onFork = vi.fn();
      render(<MessageList messages={messages} onFork={onFork} />);

      const forkButtons = screen.getAllByLabelText('Fork');
      expect(forkButtons.length).toBeGreaterThan(0);
    });

    it('does not render action buttons when callbacks are not provided', () => {
      render(<MessageList messages={messages} />);

      expect(screen.queryByLabelText('Retry')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Fork')).not.toBeInTheDocument();
    });
  });

  describe('multi-model regeneration guard', () => {
    const multiModelMessages: Message[] = [
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Compare models',
        createdAt: '2024-01-01T00:00:00Z',
        parentMessageId: null,
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'GPT response',
        createdAt: '2024-01-01T00:00:01Z',
        parentMessageId: 'u1',
        modelName: 'GPT-4o',
      },
      {
        id: 'a2',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Claude response',
        createdAt: '2024-01-01T00:00:02Z',
        parentMessageId: 'u1',
        modelName: 'Claude 3.5',
      },
    ];

    it('hides regenerate buttons on multi-model assistant messages', () => {
      const onRegenerate = vi.fn();
      render(<MessageList messages={multiModelMessages} onRegenerate={onRegenerate} />);

      // Regenerate buttons should not render for multi-model responses
      expect(screen.queryByLabelText('Regenerate')).not.toBeInTheDocument();
    });

    it('hides retry/edit buttons on user message with multiple assistant children', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      render(
        <MessageList messages={multiModelMessages} onRegenerate={onRegenerate} onEdit={onEdit} />
      );

      // The user message's retry/edit should be hidden
      expect(screen.queryByLabelText('Retry')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
    });

    it('shows regenerate buttons on single-model messages', () => {
      const singleModelMessages: Message[] = [
        {
          id: 'u1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'Hello',
          createdAt: '2024-01-01T00:00:00Z',
          parentMessageId: null,
        },
        {
          id: 'a1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Hi there',
          createdAt: '2024-01-01T00:00:01Z',
          parentMessageId: 'u1',
        },
      ];
      const onRegenerate = vi.fn();
      render(<MessageList messages={singleModelMessages} onRegenerate={onRegenerate} />);

      expect(screen.getByLabelText('Retry')).toBeInTheDocument();
      expect(screen.getByLabelText('Regenerate')).toBeInTheDocument();
    });
  });

  describe('group chat mode', () => {
    const members = [
      { id: 'member-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
      { id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'admin' },
    ];

    const groupMessages: Message[] = [
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello from Alice',
        createdAt: '2024-01-01T00:00:00Z',
        senderId: 'user-1',
      },
      {
        id: 'a2',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Second from Alice',
        createdAt: '2024-01-01T00:00:01Z',
        senderId: 'user-1',
      },
      {
        id: 'b1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hi from Bob',
        createdAt: '2024-01-01T00:00:02Z',
        senderId: 'user-2',
      },
      {
        id: 'ai1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'AI response',
        createdAt: '2024-01-01T00:00:03Z',
      },
    ];

    it('groups consecutive same-sender messages into fewer Virtuoso rows', () => {
      render(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      // 4 messages should produce 3 groups: alice×2, bob×1, AI×1
      const messageItems = screen.getAllByTestId('message-item');
      expect(messageItems).toHaveLength(3);
    });

    it('shows sender labels in group chat mode', () => {
      render(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const labels = screen.getAllByTestId('sender-label');
      // Should have labels for: alice group ("You"), bob group ("bob")
      // AI messages don't have labels
      expect(labels).toHaveLength(2);
      expect(labels[0]).toHaveTextContent('You');
      expect(labels[1]).toHaveTextContent('bob');
    });

    it('does not group messages when not in group chat mode', () => {
      render(<MessageList messages={groupMessages} />);

      // Without group chat mode, each message is a separate row
      const messageItems = screen.getAllByTestId('message-item');
      expect(messageItems).toHaveLength(4);
    });

    it('renders both messages within a grouped bubble', () => {
      render(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      // Both alice messages should be visible
      expect(screen.getByText('Hello from Alice')).toBeInTheDocument();
      expect(screen.getByText('Second from Alice')).toBeInTheDocument();
    });
  });

  describe('scroll breakaway behavior', () => {
    beforeEach(() => {
      capturedVirtuosoProps = {};
    });

    it('passes atBottomStateChange callback to Virtuoso', () => {
      render(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['atBottomStateChange']).toBeDefined();
      expect(typeof capturedVirtuosoProps['atBottomStateChange']).toBe('function');
    });

    it('followOutput returns true when user is at bottom', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      expect(followOutput(true)).toBe(true);
    });

    it('followOutput returns true regardless of isAtBottom when user has not scrolled away', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      expect(followOutput(false)).toBe(true);
    });

    it('followOutput returns false after user scrolls away even when isAtBottom is true', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;

      // User scrolls away
      atBottomStateChange(false);

      // Even if Virtuoso reports isAtBottom=true (e.g. smooth scroll animation),
      // followOutput should respect the breakaway state
      expect(followOutput(true)).toBe(false);
    });

    it('followOutput re-engages after user scrolls back to bottom', () => {
      render(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;

      // User scrolls away
      atBottomStateChange(false);
      expect(followOutput(true)).toBe(false);

      // User scrolls back to bottom
      atBottomStateChange(true);
      expect(followOutput(true)).toBe(true);
    });

    it('exposes resetScrollBreakaway via ref', () => {
      const ref = React.createRef<MessageListHandle>();
      render(<MessageList ref={ref} messages={messages} />);

      expect(ref.current).toBeDefined();
      expect(typeof ref.current?.resetScrollBreakaway).toBe('function');
    });

    it('resetScrollBreakaway re-enables auto-scroll after breakaway', () => {
      const ref = React.createRef<MessageListHandle>();
      render(<MessageList ref={ref} messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;

      // User scrolls away
      atBottomStateChange(false);
      expect(followOutput(true)).toBe(false);

      // Parent resets breakaway (e.g. user sent a message)
      ref.current?.resetScrollBreakaway();
      expect(followOutput(true)).toBe(true);
    });
  });
});
