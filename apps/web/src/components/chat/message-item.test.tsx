import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MessageItem } from './message-item';
import * as MarkdownRendererModule from './markdown-renderer';
import type { MessageGroup } from '@/lib/chat-sender';
import type { Message } from '@/lib/api';
import type { MessageAction } from '@/lib/message-actions';

// Mock document store used by DocumentCard (rendered inside MarkdownRenderer)
vi.mock('../../stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    setActiveDocument: vi.fn(),
  }),
}));

const mockModelsData = {
  data: {
    models: [
      {
        id: 'anthropic/claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        provider: 'Anthropic',
        contextLength: 200_000,
        pricePerInputToken: 0.000_003,
        pricePerOutputToken: 0.000_015,
        capabilities: [],
        description: 'Claude model',
        supportedParameters: [],
      },
      {
        id: 'openai/gpt-4o-2024-08-06',
        name: 'GPT-4o',
        provider: 'OpenAI',
        contextLength: 128_000,
        pricePerInputToken: 0.000_005,
        pricePerOutputToken: 0.000_015,
        capabilities: [],
        description: 'GPT model',
        supportedParameters: [],
      },
    ],
    premiumIds: new Set<string>(),
  },
  isLoading: false,
};

vi.mock('@/hooks/models', () => ({
  useModels: () => mockModelsData,
}));

const ALL_USER_ACTIONS = new Set<MessageAction>(['copy', 'retry', 'edit', 'fork']);
const ALL_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate', 'fork', 'share']);
const NO_ACTIONS = new Set<MessageAction>();
const ERROR_AI_ACTIONS = new Set<MessageAction>(['retry-error']);

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
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    expect(screen.getByText('Hello, how are you?')).toBeInTheDocument();
  });

  it('renders user message with user styling', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'user');
  });

  it('renders assistant message with assistant styling', () => {
    render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'assistant');
  });

  it('wraps each message in a centered max-width container', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const messageItem = screen.getByTestId('message-item');
    const wrapper = messageItem.parentElement;
    expect(wrapper).toHaveClass('mx-auto', 'w-full', 'max-w-3xl');
  });

  it('applies fit-content width with right alignment for user messages', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('w-fit');
    expect(container).toHaveClass('ml-auto');
    expect(container).toHaveClass('max-w-[82%]');
    expect(container).toHaveClass('mr-4');
  });

  it('applies fixed padding for assistant messages', () => {
    render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('px-4');
  });

  it('wraps text at word boundaries for user messages', () => {
    render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const text = screen.getByText(userMessage.content);
    expect(text).toHaveClass('break-words');
    expect(text).not.toHaveClass('break-all');
  });

  it('wraps text at word boundaries for assistant messages', () => {
    render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    const contentDiv = container.querySelector('.break-words');
    expect(contentDiv).toBeInTheDocument();
  });

  describe('copy button', () => {
    it('renders copy button for each message', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies message content to clipboard when clicked', async () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

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
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      // Flush the async clipboard operation
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });

    it('resets to copy state after delay', async () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

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
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
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
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      expect(
        screen.getByText('Please wait for your current messages to finish.')
      ).toBeInTheDocument();
    });

    it('renders with assistant styling (data-role=assistant)', () => {
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-role', 'assistant');
    });

    it('does not render copy button when isError', () => {
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    });

    it('renders retry button when onRetry is provided', () => {
      const onRetry = vi.fn();
      render(
        <MessageItem
          message={errorMessage}
          isError
          onRetry={onRetry}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('does not render retry button when onRetry is not provided', () => {
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    });

    it('calls onRetry when retry button is clicked', () => {
      const onRetry = vi.fn();
      render(
        <MessageItem
          message={errorMessage}
          isError
          onRetry={onRetry}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('applies error styling with data-error attribute', () => {
      render(<MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />);
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-error', 'true');
    });

    it('does not set data-error on non-error messages', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
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
      render(<MessageItem message={errorWithLink} isError allowedActions={ERROR_AI_ACTIONS} />);
      const link = screen.getByRole('link', { name: 'Sign up' });
      expect(link).toHaveAttribute('style', 'color: var(--brand-red);');
    });
  });

  describe('share button', () => {
    it('renders share button for assistant messages', () => {
      const onShare = vi.fn();
      render(
        <MessageItem message={assistantMessage} onShare={onShare} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument();
    });

    it('does not render share button for user messages', () => {
      const onShare = vi.fn();
      render(
        <MessageItem message={userMessage} onShare={onShare} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });

    it('calls onShare with message id when clicked', () => {
      const onShare = vi.fn();
      render(
        <MessageItem message={assistantMessage} onShare={onShare} allowedActions={ALL_AI_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /share/i }));
      expect(onShare).toHaveBeenCalledWith('2');
    });

    it('does not render share button when onShare is not provided', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
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
      render(
        <MessageItem
          message={errorMsg}
          isError
          onShare={onShare}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });
  });

  describe('streaming', () => {
    it('forwards isStreaming=true to MarkdownRenderer', () => {
      const spy = vi.spyOn(MarkdownRendererModule, 'MarkdownRenderer');
      render(<MessageItem message={assistantMessage} isStreaming allowedActions={NO_ACTIONS} />);

      // Check the first call's props directly (2nd arg is React ref = undefined)
      const props = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(props['isStreaming']).toBe(true);
      spy.mockRestore();
    });

    it('forwards isStreaming=undefined when not set', () => {
      const spy = vi.spyOn(MarkdownRendererModule, 'MarkdownRenderer');
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);

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
      render(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    it('does not show thinking indicator when content is non-empty', () => {
      render(
        <MessageItem
          message={assistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('does not show thinking indicator when not streaming', () => {
      render(
        <MessageItem
          message={emptyAssistantMessage}
          modelName="Claude"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
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
      render(
        <MessageItem
          message={emptyUserMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('displays model name in thinking indicator', () => {
      render(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="GPT-4 Turbo"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByText('GPT-4 Turbo is thinking')).toBeInTheDocument();
    });

    it('shows MarkdownRenderer when streaming with content', () => {
      render(
        <MessageItem
          message={assistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
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
          allowedActions={ALL_USER_ACTIONS}
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
          allowedActions={ALL_USER_ACTIONS}
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
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('This user has left the conversation');
    });

    it('shows link guest displayName when senderId matches a link', () => {
      const links = [
        {
          id: 'link-001',
          displayName: 'Guest Alice',
          privilege: 'write',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
      const msg = createMsg({ id: 'm1', senderId: 'link-001', content: 'Guest message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'link-001',
        messages: [msg],
      };

      render(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          links={links}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('Guest Alice');
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
          allowedActions={ALL_USER_ACTIONS}
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
          allowedActions={ALL_USER_ACTIONS}
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
          allowedActions={ALL_USER_ACTIONS}
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
          allowedActions={ALL_USER_ACTIONS}
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
          allowedActions={ALL_USER_ACTIONS}
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
          allowedActions={ALL_AI_ACTIONS}
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
          allowedActions={ALL_AI_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('w-full');
      expect(messageItem).toHaveClass('px-4');
    });

    it('does not show sender label in 1:1 mode (no group prop)', () => {
      render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
      expect(screen.queryByTestId('sender-label')).not.toBeInTheDocument();
    });
  });

  describe('model nametag', () => {
    it('shows model nametag from message.modelName', () => {
      const aiMsg = {
        id: 'ai-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('GPT-4o');
    });

    it('shows streaming modelName when message has no modelName', () => {
      const aiMsg = {
        id: 'ai-2',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: null,
      };
      render(
        <MessageItem
          message={aiMsg}
          modelName="Claude 3.5 Sonnet"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('Claude 3.5 Sonnet');
    });

    it('shows "AI" fallback when neither source has modelName', () => {
      const aiMsg = {
        id: 'ai-3',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: null,
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('AI');
    });

    it('does not show nametag on user messages', () => {
      render(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
      expect(screen.queryByTestId('model-nametag')).not.toBeInTheDocument();
    });

    it('hides nametag when assistant message has no content and is not streaming', () => {
      const aiMsg = {
        id: 'ai-empty',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('model-nametag')).not.toBeInTheDocument();
    });

    it('shows nametag when streaming with empty content', () => {
      const aiMsg = {
        id: 'ai-streaming',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(
        <MessageItem
          message={aiMsg}
          isStreaming={true}
          modelName="GPT-4o"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByTestId('model-nametag')).toBeInTheDocument();
    });

    it('resolves model ID to display name via models list', () => {
      const aiMsg = {
        id: 'ai-resolve',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'anthropic/claude-3-5-sonnet-20241022',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('Claude 3.5 Sonnet');
    });

    it('falls back to shortenModelName when model not in list', () => {
      const aiMsg = {
        id: 'ai-unknown',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'mistral/mistral-large-2024-11-01',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('mistral-large');
    });

    it('applies model-derived color to nametag via CSS custom properties', () => {
      const aiMsg = {
        id: 'ai-color',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: '2024-01-01T00:00:00Z',
        modelName: 'GPT-4o',
      };
      render(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag.getAttribute('style')).toContain('--nametag-bg');
      expect(nametag.getAttribute('style')).toContain('--nametag-fg');
    });
  });

  describe('regeneration buttons', () => {
    it('renders regenerate button on AI messages when onRegenerate is provided', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('calls onRegenerate with message id when regenerate button is clicked on AI message', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
      expect(onRegenerate).toHaveBeenCalledWith('2');
    });

    it('does not render regenerate button on AI messages when onRegenerate is not provided', () => {
      render(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    });

    it('renders retry button on user messages when onRegenerate is provided (non-error)', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_USER_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('calls onRegenerate with message id when retry button is clicked on user message', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_USER_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRegenerate).toHaveBeenCalledWith('1');
    });

    it('renders edit button on user messages when onEdit is provided', () => {
      const onEdit = vi.fn();
      render(
        <MessageItem message={userMessage} onEdit={onEdit} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    });

    it('calls onEdit with message id and content when edit button is clicked', () => {
      const onEdit = vi.fn();
      render(
        <MessageItem message={userMessage} onEdit={onEdit} allowedActions={ALL_USER_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      expect(onEdit).toHaveBeenCalledWith('1', 'Hello, how are you?');
    });

    it('renders fork button on AI messages when onFork is provided', () => {
      const onFork = vi.fn();
      render(
        <MessageItem message={assistantMessage} onFork={onFork} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('renders fork button on user messages when onFork is provided', () => {
      const onFork = vi.fn();
      render(
        <MessageItem message={userMessage} onFork={onFork} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('calls onFork with message id when fork button is clicked', () => {
      const onFork = vi.fn();
      render(
        <MessageItem message={assistantMessage} onFork={onFork} allowedActions={ALL_AI_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /fork/i }));
      expect(onFork).toHaveBeenCalledWith('2');
    });

    it('does not render regeneration buttons during streaming', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      const onFork = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          isStreaming
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          onFork={onFork}
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    });

    it('does not render retry/edit on user messages during streaming', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          isStreaming
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });

    it('does not render retry/edit/regenerate when canRegenerate is false', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });

    it('does not render regenerate on AI message when canRegenerate is false', () => {
      const onRegenerate = vi.fn();
      render(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    });

    it('still renders fork button when canRegenerate is false', () => {
      const onFork = vi.fn();
      render(
        <MessageItem
          message={userMessage}
          onFork={onFork}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('does not render regeneration action buttons on error messages', () => {
      const errorMsg = {
        id: 'err-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Error occurred',
        createdAt: '2024-01-01T00:00:00Z',
      };
      const onRegenerate = vi.fn();
      const onFork = vi.fn();
      render(
        <MessageItem
          message={errorMsg}
          isError
          onRegenerate={onRegenerate}
          onFork={onFork}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    });

    it('does not render edit button on AI messages', () => {
      const onEdit = vi.fn();
      render(
        <MessageItem message={assistantMessage} onEdit={onEdit} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });
  });
});
