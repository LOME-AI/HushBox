import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthenticatedChatPage } from './authenticated-chat-page';
import { setEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import type { Message } from '@/lib/api';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  Navigate: ({ to }: { to: string }) => {
    mockNavigate(to);
    return <div data-testid="navigate" data-to={to} />;
  },
}));

const mockSetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn().mockResolvedValue(null);

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidateQueries,
  }),
}));

vi.mock('@/components/chat/chat-layout', () => ({
  ChatLayout: ({
    messages,
    onSubmit,
    onSubmitUserOnly,
    inputValue,
    onInputChange,
    inputDisabled,
    isProcessing,
    historyCharacters,
    title,
    isDecrypting,
    conversationId,
    groupChat,
    streamingMessageId,
  }: {
    messages: Message[];
    onSubmit: () => void;
    onSubmitUserOnly?: () => void;
    inputValue: string;
    onInputChange: (v: string) => void;
    inputDisabled: boolean;
    isProcessing: boolean;
    historyCharacters: number;
    title?: string;
    isDecrypting?: boolean;
    conversationId?: string;
    groupChat?: { conversationId: string };
    streamingMessageId?: string | null;
  }) => (
    <div
      data-testid="chat-layout"
      data-decrypting={isDecrypting ? 'true' : undefined}
      data-conversation-id={conversationId ?? groupChat?.conversationId ?? ''}
      {...(streamingMessageId !== undefined &&
        streamingMessageId !== null && { 'data-streaming-id': streamingMessageId })}
    >
      <div data-testid="message-count">{messages.length}</div>
      <div data-testid="history-characters">{historyCharacters}</div>
      <div data-testid="input-disabled">{String(inputDisabled)}</div>
      <div data-testid="is-processing">{String(isProcessing)}</div>
      <div data-testid="title">{title ?? ''}</div>
      <div data-testid="message-ids">{messages.map((m) => m.id).join(',')}</div>
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
      {onSubmitUserOnly && (
        <button data-testid="submit-user-only" onClick={onSubmitUserOnly}>
          Submit User Only
        </button>
      )}
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
}

const mockStartStreaming = vi.fn();
const mockStopStreaming = vi.fn();
const mockSetInputValue = vi.fn();
const mockClearInput = vi.fn();
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
vi.mock('@/hooks/use-chat-stream', () => {
  class BalanceReservedError extends Error {
    public readonly isBalanceReserved = true;
    constructor(public readonly code: string) {
      super(code);
      this.name = 'BalanceReservedError';
    }
  }
  class BillingMismatchError extends Error {
    public readonly isBillingMismatch = true;
    constructor(public readonly code: string) {
      super(code);
      this.name = 'BillingMismatchError';
    }
  }
  class ContextCapacityError extends Error {
    public readonly isContextCapacity = true;
    constructor(public readonly code: string) {
      super(code);
      this.name = 'ContextCapacityError';
    }
  }
  return {
    useChatStream: (): ChatStreamMock => mockUseChatStream(),
    BalanceReservedError,
    BillingMismatchError,
    ContextCapacityError,
  };
});

const mockSetError = vi.fn();
const mockClearError = vi.fn();
const mockChatErrorState = {
  error: null as null | {
    id: string;
    content: string;
    retryable: boolean;
    failedUserMessage: { id: string; content: string };
  },
};
vi.mock('@/stores/chat-error', () => ({
  useChatErrorStore: Object.assign(
    (selector?: (state: typeof mockChatErrorState) => unknown) =>
      selector ? selector(mockChatErrorState) : mockChatErrorState,
    {
      getState: () => ({
        ...mockChatErrorState,
        setError: mockSetError,
        clearError: mockClearError,
      }),
    }
  ),
  createChatError: vi.fn(
    (params: { content: string; retryable: boolean; failedContent: string }) => ({
      id: 'error-id',
      content: params.content,
      retryable: params.retryable,
      failedUserMessage: { id: 'failed-msg-id', content: params.failedContent },
    })
  ),
}));

interface CreateConversationMock {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

const mockCreateConversationMutateAsync = vi.fn();
const mockUseCreateConversation = vi.fn<() => CreateConversationMock>();

interface ConversationQueryMock {
  data: { id: string; title: string; titleEpochNumber?: number; currentEpoch?: number } | undefined;
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
  useConversation: (id: string): ConversationQueryMock => mockUseConversation(id),
  useMessages: (id: string): MessagesQueryMock => mockUseMessages(id),
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
  DECRYPTING_TITLE: 'Decrypting...',
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

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    generateChatTitle: (content: string) => `Chat: ${content.slice(0, 10)}`,
    toBase64: (data: Uint8Array) => `base64-${String(data[0])}`,
    fromBase64: (string_: string) =>
      new Uint8Array(Array.from(string_, (c) => c.codePointAt(0) ?? 0)),
  };
});

const mockPrivateKey = new Uint8Array(32).fill(1);

vi.mock('@hushbox/crypto', () => ({
  createFirstEpoch: () => ({
    epochPublicKey: new Uint8Array(32).fill(10),
    epochPrivateKey: new Uint8Array(32).fill(11),
    confirmationHash: new Uint8Array(32).fill(12),
    memberWraps: [
      { memberPublicKey: new Uint8Array(32).fill(13), wrap: new Uint8Array(48).fill(14) },
    ],
  }),
  getPublicKeyFromPrivate: () => new Uint8Array(32).fill(13),
  encryptMessageForStorage: () => new Uint8Array(64).fill(20),
  decryptMessage: (_key: Uint8Array, _blob: Uint8Array) => 'Decrypted Title',
}));

let mockAuthPrivateKey: Uint8Array | null = mockPrivateKey;

vi.mock('@/lib/auth', () => ({
  useAuthStore: (selector: (state: { privateKey: Uint8Array | null }) => unknown) =>
    selector({ privateKey: mockAuthPrivateKey }),
}));

vi.mock('@/hooks/use-decrypted-messages', () => ({
  useDecryptedMessages: (_conversationId: string | null, msgs: Message[] | undefined) => msgs ?? [],
}));

const mockUseGroupChat = vi.fn();
vi.mock('@/hooks/use-group-chat', () => ({
  useGroupChat: (conversationId: string | null, plaintextTitle?: string) =>
    mockUseGroupChat(conversationId, plaintextTitle),
}));

const mockFetchJson = vi.fn();
vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      chat: {
        message: {
          $post: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

interface StreamOptions {
  onToken?: (token: string) => void;
  onStart?: (data: { assistantMessageId: string }) => void;
}

interface SetupMocksOptions {
  pendingMessage?: string | null;
  isStreaming?: boolean;
  isPending?: boolean;
  conversationData?:
    | { id: string; title: string; titleEpochNumber?: number; currentEpoch?: number }
    | undefined;
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
  });

  mockUseChatStream.mockReturnValue({
    isStreaming,
    startStream: mockStartStream,
  });

  mockUseCreateConversation.mockReturnValue({
    mutateAsync: mockCreateConversationMutateAsync,
    isPending,
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
    isNew: true,
  });
  mockStartStream.mockResolvedValue({
    assistantMessageId: 'assistant-1',
    content: 'Response',
  });
}

describe('AuthenticatedChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
    mockPendingMessage = null;
    streamingMessageIdRef.current = null;
    mockChatErrorState.error = null;
    mockAuthPrivateKey = mockPrivateKey;
    mockUseGroupChat.mockImplementation((conversationId: string | null) => {
      if (!conversationId) return;
      return {
        conversationId,
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
      };
    });
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

    it('creates conversation with generated UUID and epoch fields', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockCreateConversationMutateAsync).toHaveBeenCalledWith({
          id: expect.any(String),
          title: 'base64-20',
          epochPublicKey: 'base64-10',
          confirmationHash: 'base64-12',
          memberWrap: 'base64-14',
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
          expect.objectContaining({
            conversationId: 'conv-123',
            model: 'test-model',
            userMessage: expect.objectContaining({
              id: expect.any(String),
              content: expect.any(String),
            }),
            messagesForInference: [{ role: 'user', content: 'Hello AI' }],
          }),
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

    it('shows generic error to user when first-message stream fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockRejectedValue(new Error('Stream failed'));

      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          expect.objectContaining({
            retryable: false,
          })
        );
      });

      consoleErrorSpy.mockRestore();
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

    it('does not create conversation when accountPrivateKey is null', () => {
      mockAuthPrivateKey = null;
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      expect(mockCreateConversationMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('existing chat mode (routeConversationId === UUID)', () => {
    it('fetches conversation and messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseConversation).toHaveBeenCalledWith('conv-456');
      expect(mockUseMessages).toHaveBeenCalledWith('conv-456');
    });

    it('renders ChatLayout with isDecrypting while fetching', () => {
      setupMocks({
        isConversationLoading: true,
        isMessagesLoading: true,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toBeInTheDocument();
      expect(layout).toHaveAttribute('data-decrypting', 'true');
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('displays messages from API', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
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

    it('displays decrypted conversation title when epoch key available', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Decrypted Title');
    });

    it('displays Decrypting... when epoch key not available', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Decrypting...');
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
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });

      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-456',
          model: 'test-model',
          userMessage: expect.objectContaining({
            id: expect.any(String),
            content: 'New message',
          }),
          messagesForInference: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'New message' }),
          ]),
        }),
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

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('streams assistant response after message sent', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: 'conv-456',
            model: 'test-model',
          }),
          expect.any(Object)
        );
      });
    });

    it('passes displayTitle to useGroupChat for epoch rotation', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith('conv-456', 'Decrypted Title');
    });

    it('passes conversationId via groupChat to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith('conv-456', expect.anything());
      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('passes conversationId directly to ChatLayout even when groupChat is undefined', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument
      mockUseGroupChat.mockReturnValue(undefined);
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('passes null to useGroupChat initially for new conversation', () => {
      setupMocks({ pendingMessage: null });

      render(<AuthenticatedChatPage routeConversationId="new" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith(null, undefined);
    });

    it('passes realConversationId to useGroupChat after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockUseGroupChat).toHaveBeenCalledWith('conv-123', expect.anything());
      });
    });

    it('passes groupChat members from useGroupChat hook', () => {
      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
      });
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('calculates history characters from messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hello',
            createdAt: '',
          },
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

    it('appends phantom messages from remoteStreamingMessages to messages array', () => {
      const phantomMap = new Map([
        [
          'phantom-user-1',
          { content: 'Hello from Bob', senderType: 'user' as const, senderId: 'u2' },
        ],
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // 1 real message + 2 phantom messages = 3
      expect(screen.getByTestId('message-count')).toHaveTextContent('3');
      expect(screen.getByTestId('message-ids')).toHaveTextContent('m1,phantom-user-1,phantom-ai-1');
    });

    it('sets streamingMessageId to remote AI phantom when no local streaming', () => {
      const phantomMap = new Map([
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute(
        'data-streaming-id',
        'phantom-ai-1'
      );
    });

    it('deduplicates phantom messages whose IDs already exist in API messages', () => {
      const phantomMap = new Map([
        ['m1', { content: 'Hello from Bob', senderType: 'user' as const, senderId: 'u2' }],
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // phantom 'm1' should be deduped (already in API messages), only phantom-ai-1 remains
      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
      expect(screen.getByTestId('message-ids')).toHaveTextContent('m1,phantom-ai-1');
    });

    it('does not append phantom messages when remoteStreamingMessages is empty', () => {
      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: new Map(),
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });
  });

  describe('state reset on navigation', () => {
    it('resets state when navigating between existing conversations', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setEpochKey('conv-789', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-1', titleEpochNumber: 1 },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // Navigate to different conversation
      setupMocks({
        conversationData: { id: 'conv-789', title: 'encrypted-2', titleEpochNumber: 1 },
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

      // Should show decrypted title for new conversation
      expect(screen.getByTestId('title')).toHaveTextContent('Decrypted Title');
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
    it('shows generic error to user for unrecognized errors', async () => {
      const user = userEvent.setup();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockStartStream.mockRejectedValue(new Error('Stream failed'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });

      expect(mockSetError).toHaveBeenCalledWith(
        expect.objectContaining({
          retryable: false,
          failedUserMessage: expect.objectContaining({
            content: 'Test message',
          }),
        })
      );
      consoleErrorSpy.mockRestore();
    });

    it('sets retryable chat error and invalidates billing on BillingMismatchError', async () => {
      const { BillingMismatchError } = await import('@/hooks/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new BillingMismatchError('BILLING_MISMATCH'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ['balance'],
        });
      });

      expect(mockSetError).toHaveBeenCalledWith(
        expect.objectContaining({
          retryable: true,
          failedUserMessage: expect.objectContaining({
            content: 'Test message',
          }),
        })
      );
    });

    it('sets non-retryable chat error on ContextCapacityError', async () => {
      const { ContextCapacityError } = await import('@/hooks/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new ContextCapacityError('context_length_exceeded'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          expect.objectContaining({
            retryable: false,
            failedUserMessage: expect.objectContaining({
              content: 'Test message',
            }),
          })
        );
      });
    });

    it('sets chat error on BalanceReservedError', async () => {
      const { BalanceReservedError } = await import('@/hooks/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new BalanceReservedError('BALANCE_RESERVED'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          expect.objectContaining({
            retryable: true,
            failedUserMessage: expect.objectContaining({
              content: 'Test message',
            }),
          })
        );
      });
    });
  });

  describe('error message in messages list', () => {
    it('appends error message to messages when chat error exists', () => {
      mockChatErrorState.error = {
        id: 'error-id',
        content: 'Please wait for your current messages to finish.',
        retryable: true,
        failedUserMessage: { id: 'failed-msg-id', content: 'Hello' },
      };

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // 1 real message + 1 error message = 2
      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });

    it('does not append error message when no error exists', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });
  });

  describe('error cleanup', () => {
    it('clears chat error when submitting a new message', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'Retry message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearError).toHaveBeenCalled();
      });
    });

    it('clears chat error when navigating between conversations', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setEpochKey('conv-789', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-1', titleEpochNumber: 1 },
        messagesData: [],
      });

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      mockClearError.mockClear();

      setupMocks({
        conversationData: { id: 'conv-789', title: 'encrypted-2', titleEpochNumber: 1 },
        messagesData: [],
      });

      rerender(<AuthenticatedChatPage routeConversationId="conv-789" />);

      expect(mockClearError).toHaveBeenCalled();
    });

    it('clears chat error on unmount', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      const { unmount } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      mockClearError.mockClear();
      unmount();

      expect(mockClearError).toHaveBeenCalled();
    });
  });

  describe('user-only messages (AI toggle off)', () => {
    it('passes onSubmitUserOnly to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('submit-user-only')).toBeInTheDocument();
    });

    it('sends user-only message via fetchJson without streaming', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockFetchJson).toHaveBeenCalled();
      });

      // No streaming should be triggered
      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('clears input after sending user-only message', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });

    it('does not send user-only message when input is empty', async () => {
      const user = userEvent.setup();

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: '   ',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('invalidates messages query after successful user-only send', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ['messages', 'conv-456'],
        });
      });
    });
  });
});
