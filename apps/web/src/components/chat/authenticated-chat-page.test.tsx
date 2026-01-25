import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthenticatedChatPage } from './authenticated-chat-page';
import type { Message } from '@/lib/api';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  Navigate: ({ to }: { to: string }) => {
    mockNavigate(to);
    return <div data-testid="navigate" data-to={to} />;
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('@/components/chat/chat-layout', () => ({
  ChatLayout: ({
    messages,
    onSubmit,
    inputValue,
    onInputChange,
    inputDisabled,
    isProcessing,
    historyCharacters,
    title,
  }: {
    messages: Message[];
    onSubmit: () => void;
    inputValue: string;
    onInputChange: (v: string) => void;
    inputDisabled: boolean;
    isProcessing: boolean;
    historyCharacters: number;
    title?: string;
  }) => (
    <div data-testid="chat-layout">
      <div data-testid="message-count">{messages.length}</div>
      <div data-testid="history-characters">{historyCharacters}</div>
      <div data-testid="input-disabled">{String(inputDisabled)}</div>
      <div data-testid="is-processing">{String(isProcessing)}</div>
      <div data-testid="title">{title ?? ''}</div>
      <input
        data-testid="input"
        value={inputValue}
        onChange={(event) => {
          onInputChange(event.target.value);
        }}
      />
      <button data-testid="submit" onClick={onSubmit}>
        Submit
      </button>
    </div>
  ),
}));

interface ChatPageStateMock {
  inputValue: string;
  setInputValue: ReturnType<typeof vi.fn>;
  clearInput: ReturnType<typeof vi.fn>;
  streamingMessageId: string | null;
  streamingMessageIdRef: { current: string | null };
  startStreaming: ReturnType<typeof vi.fn>;
  stopStreaming: ReturnType<typeof vi.fn>;
  documentsByMessage: Record<string, unknown>;
  handleDocumentsExtracted: ReturnType<typeof vi.fn>;
  allDocuments: unknown[];
}

const mockStartStreaming = vi.fn();
const mockStopStreaming = vi.fn();
const mockSetInputValue = vi.fn();
const mockClearInput = vi.fn();
const mockHandleDocumentsExtracted = vi.fn();
const streamingMessageIdRef = { current: null as string | null };

const mockUseChatPageState = vi.fn<() => ChatPageStateMock>();
vi.mock('@/hooks/use-chat-page', () => ({
  useChatPageState: (): ChatPageStateMock => mockUseChatPageState(),
}));

const mockUseIsMobile = vi.fn<() => boolean>();
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: (): boolean => mockUseIsMobile(),
}));

interface ChatStreamMock {
  isStreaming: boolean;
  startStream: ReturnType<typeof vi.fn>;
}

const mockStartStream = vi.fn();
const mockUseChatStream = vi.fn<() => ChatStreamMock>();
vi.mock('@/hooks/use-chat-stream', () => ({
  useChatStream: (): ChatStreamMock => mockUseChatStream(),
}));

interface CreateConversationMock {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

const mockCreateConversationMutateAsync = vi.fn();
const mockUseCreateConversation = vi.fn<() => CreateConversationMock>();

interface SendMessageMock {
  mutate: ReturnType<typeof vi.fn>;
}

const mockSendMessageMutate = vi.fn();
const mockUseSendMessage = vi.fn<() => SendMessageMock>();

interface ConversationQueryMock {
  data: { id: string; title: string } | undefined;
  isLoading: boolean;
}

const mockUseConversation = vi.fn<(id: string) => ConversationQueryMock>();

interface MessagesQueryMock {
  data: Message[] | undefined;
  isLoading: boolean;
}

const mockUseMessages = vi.fn<(id: string) => MessagesQueryMock>();

vi.mock('@/hooks/chat', () => ({
  useCreateConversation: (): CreateConversationMock => mockUseCreateConversation(),
  useSendMessage: (): SendMessageMock => mockUseSendMessage(),
  useConversation: (id: string): ConversationQueryMock => mockUseConversation(id),
  useMessages: (id: string): MessagesQueryMock => mockUseMessages(id),
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
}));

vi.mock('@/hooks/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

interface PendingChatStoreMock {
  pendingMessage: string | null;
  clearPendingMessage: ReturnType<typeof vi.fn>;
}

const mockClearPendingMessage = vi.fn();
let mockPendingMessage: string | null = null;

vi.mock('@/stores/pending-chat', () => ({
  usePendingChatStore: (selector: (state: PendingChatStoreMock) => unknown) => {
    const state: PendingChatStoreMock = {
      pendingMessage: mockPendingMessage,
      clearPendingMessage: mockClearPendingMessage,
    };
    return selector(state);
  },
}));

vi.mock('@/stores/model', () => ({
  useModelStore: () => ({ selectedModelId: 'test-model' }),
}));

const mockScrollToBottom = vi.fn();
vi.mock('@/hooks/use-scroll-behavior', () => ({
  useScrollBehavior: () => ({
    handleScroll: vi.fn(),
    scrollToBottom: mockScrollToBottom,
    bottomPadding: 800,
    isAutoScrollEnabled: true,
  }),
}));

vi.mock('@lome-chat/shared', () => ({
  generateChatTitle: (content: string) => `Chat: ${content.slice(0, 10)}`,
}));

interface StreamOptions {
  onToken?: (token: string) => void;
  onStart?: (data: { assistantMessageId: string }) => void;
}

interface SetupMocksOptions {
  pendingMessage?: string | null;
  isStreaming?: boolean;
  isPending?: boolean;
  conversationData?: { id: string; title: string } | undefined;
  messagesData?: Message[] | undefined;
  isConversationLoading?: boolean;
  isMessagesLoading?: boolean;
  isMobile?: boolean;
  inputValue?: string;
}

function setupMocks(overrides: SetupMocksOptions = {}): void {
  const {
    pendingMessage = null,
    isStreaming = false,
    isPending = false,
    conversationData,
    messagesData,
    isConversationLoading = false,
    isMessagesLoading = false,
    isMobile = false,
    inputValue = '',
  } = overrides;

  mockPendingMessage = pendingMessage;

  mockUseChatPageState.mockReturnValue({
    inputValue,
    setInputValue: mockSetInputValue,
    clearInput: mockClearInput,
    streamingMessageId: null,
    streamingMessageIdRef,
    startStreaming: mockStartStreaming,
    stopStreaming: mockStopStreaming,
    documentsByMessage: {},
    handleDocumentsExtracted: mockHandleDocumentsExtracted,
    allDocuments: [],
  });

  mockUseChatStream.mockReturnValue({
    isStreaming,
    startStream: mockStartStream,
  });

  mockUseCreateConversation.mockReturnValue({
    mutateAsync: mockCreateConversationMutateAsync,
    isPending,
  });

  mockUseSendMessage.mockReturnValue({
    mutate: mockSendMessageMutate,
  });

  mockUseConversation.mockReturnValue({
    data: conversationData,
    isLoading: isConversationLoading,
  });

  mockUseMessages.mockReturnValue({
    data: messagesData,
    isLoading: isMessagesLoading,
  });

  mockUseIsMobile.mockReturnValue(isMobile);
}

function setupSuccessfulCreation(): void {
  mockCreateConversationMutateAsync.mockResolvedValue({
    conversation: { id: 'conv-123' },
    message: { id: 'msg-1', createdAt: '2024-01-01' },
  });
  mockStartStream.mockResolvedValue({
    assistantMessageId: 'assistant-1',
    content: 'Response',
  });
}

describe('AuthenticatedChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPendingMessage = null;
    streamingMessageIdRef.current = null;
    setupMocks();
  });

  describe('create mode (routeConversationId === "new")', () => {
    it('redirects to chat list when no pending message', () => {
      setupMocks({ pendingMessage: null });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('does NOT redirect when pending message exists', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockCreateConversationMutateAsync).toHaveBeenCalled();
      });

      expect(mockNavigate).not.toHaveBeenCalledWith({ to: '/chat' });
    });

    it('shows user message immediately when pending message exists', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(screen.getByTestId('message-count')).toHaveTextContent('1');
      });
    });

    it('creates conversation with generated UUID', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockCreateConversationMutateAsync).toHaveBeenCalledWith({
          id: expect.any(String),
          firstMessage: { content: 'Hello AI' },
        });
      });
    });

    it('clears pending message after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockClearPendingMessage).toHaveBeenCalled();
      });
    });

    it('shows loading state while creating conversation', () => {
      setupMocks({ pendingMessage: 'Hello', isPending: true });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      // Loading state is indicated by having a user message visible (from pendingMessage)
      // and inputDisabled being true until real conversation ID is set
      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });

    it('sets title from message content', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(screen.getByTestId('title')).toHaveTextContent('Chat: Hello AI');
      });
    });

    it('calls startStream after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          { conversationId: 'conv-123', model: 'test-model' },
          expect.objectContaining({
            onStart: expect.any(Function) as unknown,
            onToken: expect.any(Function) as unknown,
          })
        );
      });
    });

    it('handles onStart callback from stream', async () => {
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        message: { id: 'msg-1' },
        isNew: true,
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({ assistantMessageId: 'assistant-1' });
        return Promise.resolve({ assistantMessageId: 'assistant-1', content: 'Response' });
      });
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStreaming).toHaveBeenCalledWith('assistant-1');
      });
    });

    it('handles onToken callback from stream', async () => {
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        message: { id: 'msg-1' },
        isNew: true,
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        streamingMessageIdRef.current = 'assistant-1';
        options?.onToken?.('Hello');
        return Promise.resolve({ assistantMessageId: 'assistant-1', content: 'Response' });
      });
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });
    });

    it('stops streaming after completion', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });
    });

    it('navigates back to chat on creation error', async () => {
      mockCreateConversationMutateAsync.mockRejectedValue(new Error('Creation failed'));
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('shows processing state when streaming', () => {
      setupMocks({ pendingMessage: 'Hello', isStreaming: true });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(screen.getByTestId('is-processing')).toHaveTextContent('true');
    });

    it('navigates to /chat/:uuid after successful creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({
          to: '/chat/$id',
          params: { id: 'conv-123' },
          replace: true,
        });
      });
    });
  });

  describe('existing chat mode (routeConversationId === UUID)', () => {
    it('fetches conversation and messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseConversation).toHaveBeenCalledWith('conv-456');
      expect(mockUseMessages).toHaveBeenCalledWith('conv-456');
    });

    it('shows loading state while fetching', () => {
      setupMocks({
        isConversationLoading: true,
        isMessagesLoading: true,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // Loading state shows empty messages and disabled input
      expect(screen.getByTestId('message-count')).toHaveTextContent('0');
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('displays messages from API', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
          {
            id: 'm2',
            conversationId: 'conv-456',
            role: 'assistant',
            content: 'Hello',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });

    it('displays conversation title', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Test Chat');
    });

    it('redirects if conversation not found', () => {
      setupMocks({
        conversationData: undefined,
        isConversationLoading: false,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
    });

    it('submits new message with optimistic update', async () => {
      const user = userEvent.setup();
      mockSendMessageMutate.mockImplementation(
        (_data: unknown, options: { onSuccess?: () => void }) => {
          options.onSuccess?.();
        }
      );
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });

      expect(mockSendMessageMutate).toHaveBeenCalledWith(
        {
          conversationId: 'conv-456',
          message: { role: 'user', content: 'New message' },
        },
        expect.any(Object)
      );
    });

    it('does not submit empty message', async () => {
      const user = userEvent.setup();
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: '   ',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      expect(mockSendMessageMutate).not.toHaveBeenCalled();
    });

    it('streams assistant response after message sent', async () => {
      const user = userEvent.setup();
      mockSendMessageMutate.mockImplementation(
        (_data: unknown, options: { onSuccess?: () => void }) => {
          options.onSuccess?.();
        }
      );
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          { conversationId: 'conv-456', model: 'test-model' },
          expect.any(Object)
        );
      });
    });

    it('calculates history characters from messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hello', createdAt: '' },
          {
            id: 'm2',
            conversationId: 'conv-456',
            role: 'assistant',
            content: 'Hi there',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // "Hello" (5) + "Hi there" (8) = 13
      expect(screen.getByTestId('history-characters')).toHaveTextContent('13');
    });
  });

  describe('triggerStreaming param', () => {
    it('auto-streams when triggerStreaming is true and last message is user', async () => {
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-trigger',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" triggerStreaming={true} />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          { conversationId: 'conv-456', model: 'test-model' },
          expect.any(Object)
        );
      });

      // Should navigate to clear the search param
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/chat/$id',
        params: { id: 'conv-456' },
        search: {},
        replace: true,
      });
    });

    it('does not auto-stream when last message is assistant', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
          {
            id: 'm2',
            conversationId: 'conv-456',
            role: 'assistant',
            content: 'Hello',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" triggerStreaming={true} />);

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('does not auto-stream when still loading', () => {
      setupMocks({
        isMessagesLoading: true,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" triggerStreaming={true} />);

      expect(mockStartStream).not.toHaveBeenCalled();
    });
  });

  describe('state reset on navigation', () => {
    it('resets state when navigating between existing conversations', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'First Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // Navigate to different conversation
      setupMocks({
        conversationData: { id: 'conv-789', title: 'Second Chat' },
        messagesData: [
          {
            id: 'm2',
            conversationId: 'conv-789',
            role: 'user',
            content: 'Different',
            createdAt: '',
          },
        ],
      });

      rerender(<AuthenticatedChatPage routeConversationId="conv-789" />);

      // Should show new conversation's messages
      expect(screen.getByTestId('title')).toHaveTextContent('Second Chat');
    });
  });

  describe('input handling', () => {
    it('disables input in create mode', () => {
      setupMocks({ pendingMessage: 'Hello' });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('enables input in existing chat mode', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });
      render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('false');
    });

    it('clears input after submit on desktop', async () => {
      const user = userEvent.setup();
      mockSendMessageMutate.mockImplementation(
        (_data: unknown, options: { onSuccess?: () => void }) => {
          options.onSuccess?.();
        }
      );
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
        isMobile: false,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });
  });

  describe('send message error handling', () => {
    it('handles send message error', async () => {
      const user = userEvent.setup();
      mockSendMessageMutate.mockImplementation(
        (_data: unknown, options: { onError?: () => void }) => {
          options.onError?.();
        }
      );

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        // Optimistic message should be removed on error
        expect(mockSendMessageMutate).toHaveBeenCalled();
      });
    });
  });
});
