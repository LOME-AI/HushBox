import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MessageItem } from './message-item';
import * as MarkdownRendererModule from './markdown-renderer';
import type { MessageGroup } from '@/lib/chat-sender';
import type { Message } from '@/lib/api';

// Mock document store used by DocumentCard (rendered inside MarkdownRenderer)
vi.mock('../../stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    setActiveDocument: vi.fn(),
  }),
}));

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

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

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

  it('wraps each message in a centered max-width container', () => {
    render(<MessageItem message={userMessage} />);
    const messageItem = screen.getByTestId('message-item');
    const wrapper = messageItem.parentElement;
    expect(wrapper).toHaveClass('mx-auto', 'w-full', 'max-w-3xl');
  });

  it('applies fit-content width with right alignment for user messages', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('w-fit');
    expect(container).toHaveClass('ml-auto');
    expect(container).toHaveClass('max-w-[82%]');
    expect(container).toHaveClass('mr-4');
  });

  it('applies fixed padding for assistant messages', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('px-4');
  });

  it('wraps text at word boundaries for user messages', () => {
    render(<MessageItem message={userMessage} />);
    const text = screen.getByText(userMessage.content);
    expect(text).toHaveClass('break-words');
    expect(text).not.toHaveClass('break-all');
  });

  it('wraps text at word boundaries for assistant messages', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    const contentDiv = container.querySelector('.break-words');
    expect(contentDiv).toBeInTheDocument();
  });

  describe('copy button', () => {
    it('renders copy button for each message', () => {
      render(<MessageItem message={assistantMessage} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies message content to clipboard when clicked', async () => {
      render(<MessageItem message={assistantMessage} />);

      // Click the copy button
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      // Flush the async clipboard operation
      await act(async () => {
        await Promise.resolve();
      });

      // The state change to "Copied" proves clipboard.writeText succeeded
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      // Verify the message content that was copied matches
      expect(assistantMessage.content).toBe('I am doing well, thank you!');
    });

    it('shows copied feedback after clicking', async () => {
      render(<MessageItem message={assistantMessage} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      // Flush the async clipboard operation
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });

    it('resets to copy state after delay', async () => {
      render(<MessageItem message={assistantMessage} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      // Flush the async clipboard operation
      await act(async () => {
        await Promise.resolve();
      });

      // Should show "Copied"
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      // Wait for the 2 second timeout to reset
      act(() => {
        vi.advanceTimersByTime(2500);
      });

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copy button has ghost variant styling', () => {
      render(<MessageItem message={assistantMessage} />);
      const button = screen.getByRole('button', { name: /copy/i });
      // Ghost buttons typically have these classes or no background
      expect(button).toHaveClass('h-6', 'w-6');
    });
  });

  describe('error messages', () => {
    const errorMessage = {
      id: 'err-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: 'Please wait for your current messages to finish.',
      createdAt: '2024-01-01T00:00:00Z',
    };

    it('renders error content with markdown', () => {
      render(<MessageItem message={errorMessage} isError />);
      expect(
        screen.getByText('Please wait for your current messages to finish.')
      ).toBeInTheDocument();
    });

    it('renders with assistant styling (data-role=assistant)', () => {
      render(<MessageItem message={errorMessage} isError />);
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-role', 'assistant');
    });

    it('does not render copy button when isError', () => {
      render(<MessageItem message={errorMessage} isError />);
      expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    });

    it('renders retry button when onRetry is provided', () => {
      const onRetry = vi.fn();
      render(<MessageItem message={errorMessage} isError onRetry={onRetry} />);
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('does not render retry button when onRetry is not provided', () => {
      render(<MessageItem message={errorMessage} isError />);
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });

    it('calls onRetry when retry button is clicked', () => {
      const onRetry = vi.fn();
      render(<MessageItem message={errorMessage} isError onRetry={onRetry} />);
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('applies error styling with data-error attribute', () => {
      render(<MessageItem message={errorMessage} isError />);
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-error', 'true');
    });

    it('does not set data-error on non-error messages', () => {
      render(<MessageItem message={assistantMessage} />);
      const container = screen.getByTestId('message-item');
      expect(container).not.toHaveAttribute('data-error');
    });

    it('renders links with color inherit style so they appear red', () => {
      const errorWithLink = {
        id: 'err-link',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'You ran out of messages. [Sign up](/signup) to continue!',
        createdAt: '2024-01-01T00:00:00Z',
      };
      render(<MessageItem message={errorWithLink} isError />);
      const link = screen.getByRole('link', { name: 'Sign up' });
      expect(link).toHaveAttribute('style', 'color: var(--brand-red);');
    });
  });

  describe('share button', () => {
    it('renders share button for assistant messages', () => {
      const onShare = vi.fn();
      render(<MessageItem message={assistantMessage} onShare={onShare} />);
      expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument();
    });

    it('does not render share button for user messages', () => {
      const onShare = vi.fn();
      render(<MessageItem message={userMessage} onShare={onShare} />);
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });

    it('calls onShare with message id when clicked', () => {
      const onShare = vi.fn();
      render(<MessageItem message={assistantMessage} onShare={onShare} />);
      fireEvent.click(screen.getByRole('button', { name: /share/i }));
      expect(onShare).toHaveBeenCalledWith('2');
    });

    it('does not render share button when onShare is not provided', () => {
      render(<MessageItem message={assistantMessage} />);
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });

    it('does not render share button for error messages', () => {
      const errorMsg = {
        id: 'err-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Error occurred',
        createdAt: '2024-01-01T00:00:00Z',
      };
      const onShare = vi.fn();
      render(<MessageItem message={errorMsg} isError onShare={onShare} />);
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });
  });

  describe('streaming', () => {
    it('forwards isStreaming=true to MarkdownRenderer', () => {
      const spy = vi.spyOn(MarkdownRendererModule, 'MarkdownRenderer');
      render(<MessageItem message={assistantMessage} isStreaming />);

      // Check the first call's props directly (2nd arg is React ref = undefined)
      const props = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(props['isStreaming']).toBe(true);
      spy.mockRestore();
    });

    it('forwards isStreaming=undefined when not set', () => {
      const spy = vi.spyOn(MarkdownRendererModule, 'MarkdownRenderer');
      render(<MessageItem message={assistantMessage} />);

      const props = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(props['isStreaming']).toBeUndefined();
      spy.mockRestore();
    });
  });

  describe('thinking indicator', () => {
    const emptyAssistantMessage = {
      id: 'thinking-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: '',
      createdAt: '2024-01-01T00:00:00Z',
    };

    it('shows thinking indicator when streaming with empty content', () => {
      render(<MessageItem message={emptyAssistantMessage} isStreaming modelName="Claude" />);
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    it('does not show thinking indicator when content is non-empty', () => {
      render(<MessageItem message={assistantMessage} isStreaming modelName="Claude" />);
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('does not show thinking indicator when not streaming', () => {
      render(<MessageItem message={emptyAssistantMessage} modelName="Claude" />);
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('does not show thinking indicator for user messages', () => {
      const emptyUserMessage = {
        id: 'user-empty',
        conversationId: 'conv-1',
        role: 'user' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
      };
      render(<MessageItem message={emptyUserMessage} isStreaming modelName="Claude" />);
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('displays model name in thinking indicator', () => {
      render(<MessageItem message={emptyAssistantMessage} isStreaming modelName="GPT-4 Turbo" />);
      expect(screen.getByText('GPT-4 Turbo is thinking')).toBeInTheDocument();
    });

    it('shows MarkdownRenderer when streaming with content', () => {
      render(<MessageItem message={assistantMessage} isStreaming modelName="Claude" />);
      expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });
  });

  describe('group chat rendering', () => {
    const members = [
      { id: 'member-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
      { id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'admin' },
    ];

    function createMsg(overrides: Partial<Message> = {}): Message {
      return {
        id: crypto.randomUUID(),
        conversationId: 'conv-1',
        role: 'user',
        content: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('shows sender label "You" for own user message group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'Hello' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('You');
    });

    it('shows sender username for other member message group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Hi there' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('bob');
    });

    it('shows left user label for unknown senderId', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-deleted', content: 'Old message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'user-deleted',
        messages: [msg],
      };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('This user has left the conversation');
    });

    it('renders multiple messages in one group bubble', () => {
      const msg1 = createMsg({ id: 'm1', senderId: 'user-1', content: 'First message' });
      const msg2 = createMsg({ id: 'm2', senderId: 'user-1', content: 'Second message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'user-1',
        messages: [msg1, msg2],
      };

      render(
        <MessageItem
          message={msg1}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      expect(screen.getByText('First message')).toBeInTheDocument();
      expect(screen.getByText('Second message')).toBeInTheDocument();
      // Only one sender label
      expect(screen.getAllByTestId('sender-label')).toHaveLength(1);
    });

    it('applies left alignment for other member messages', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Bob says hi' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('ml-4');
      expect(messageItem).toHaveClass('mr-auto');
    });

    it('applies right alignment for own messages', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'My message' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('mr-4');
      expect(messageItem).toHaveClass('ml-auto');
    });

    it('uses bg-muted for other member bubbles', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Bob says' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      const bubble = messageItem.querySelector('.bg-muted');
      expect(bubble).toBeInTheDocument();
    });

    it('uses bg-message-user for own message bubbles in group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'My msg' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      const bubble = messageItem.querySelector('.bg-message-user');
      expect(bubble).toBeInTheDocument();
    });

    it('does not show sender label for AI messages in group chat', () => {
      const aiMsg = createMsg({ id: 'ai1', role: 'assistant', content: 'AI response' });
      const group: MessageGroup = { id: 'ai1', role: 'assistant', messages: [aiMsg] };

      render(
        <MessageItem
          message={aiMsg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      expect(screen.queryByTestId('sender-label')).not.toBeInTheDocument();
    });

    it('renders AI messages full-width in group chat (same as 1:1)', () => {
      const aiMsg = createMsg({ id: 'ai1', role: 'assistant', content: 'AI response' });
      const group: MessageGroup = { id: 'ai1', role: 'assistant', messages: [aiMsg] };

      render(
        <MessageItem
          message={aiMsg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('w-full');
      expect(messageItem).toHaveClass('px-4');
    });

    it('does not show sender label in 1:1 mode (no group prop)', () => {
      render(<MessageItem message={userMessage} />);
      expect(screen.queryByTestId('sender-label')).not.toBeInTheDocument();
    });
  });
});
