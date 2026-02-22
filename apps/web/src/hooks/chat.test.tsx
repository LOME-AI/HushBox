import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  chatKeys,
  useConversations,
  useConversation,
  useMessages,
  useCreateConversation,
  useDeleteConversation,
  useUpdateConversation,
  useDecryptedConversations,
} from './chat';

// Mock auth to break transitive import chain to api.ts (env parse)
vi.mock('../lib/auth', () => ({
  useAuthStore: vi.fn((selector: (s: { privateKey: null }) => unknown) =>
    selector({ privateKey: null })
  ),
}));

// Mock crypto and epoch-key-cache (used by useDecryptedConversations)
const mockDecryptMessage = vi.fn();
vi.mock('@hushbox/crypto', () => ({
  decryptMessage: (...args: unknown[]) => mockDecryptMessage(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
  };
});

const mockGetEpochKey = vi.fn(() => undefined as Uint8Array | undefined);
vi.mock('../lib/epoch-key-cache', () => ({
  getEpochKey: () => mockGetEpochKey(),
  processKeyChain: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

// Mock the api-client module
const mockFetchJson = vi.fn();
vi.mock('../lib/api-client', () => ({
  client: {
    api: {
      conversations: {
        $get: vi.fn(),
        $post: vi.fn(),
        ':id': {
          $get: vi.fn(),
          $delete: vi.fn(),
          $patch: vi.fn(),
        },
      },
      keys: {
        ':conversationId': {
          $get: vi.fn(),
        },
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  // eslint-disable-next-line sonarjs/function-return-type -- test wrapper returns children
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('chatKeys', () => {
  describe('all', () => {
    it('returns base chat key', () => {
      expect(chatKeys.all).toEqual(['chat']);
    });
  });

  describe('conversations', () => {
    it('returns conversations key array', () => {
      expect(chatKeys.conversations()).toEqual(['chat', 'conversations']);
    });
  });

  describe('conversation', () => {
    it('returns conversation key with id', () => {
      expect(chatKeys.conversation('conv-123')).toEqual(['chat', 'conversations', 'conv-123']);
    });
  });

  describe('messages', () => {
    it('returns messages key with conversation id', () => {
      expect(chatKeys.messages('conv-123')).toEqual([
        'chat',
        'conversations',
        'conv-123',
        'messages',
      ]);
    });
  });
});

describe('useConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches conversations from API', async () => {
    const mockConversations = [
      {
        id: '1',
        userId: 'user-1',
        title: 'Test',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
      },
    ];
    mockFetchJson.mockResolvedValueOnce({ conversations: mockConversations });

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockConversations);
  });

  it('handles API errors', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Network error');
  });
});

describe('useConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches single conversation from API', async () => {
    const mockConversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const mockMessages = [
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello',
        createdAt: '2024-01-01',
      },
    ];
    mockFetchJson.mockResolvedValueOnce({ conversation: mockConversation, messages: mockMessages });

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockConversation);
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useConversation(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

describe('useMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches messages from API', async () => {
    const mockConversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const mockMessages = [
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        encryptedBlob: 'blob-1',
        senderType: 'user',
        senderId: 'user-1',
        senderDisplayName: null,
        payerId: null,
        epochNumber: 1,
        sequenceNumber: 0,
        createdAt: '2024-01-01',
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        encryptedBlob: 'blob-2',
        senderType: 'ai',
        senderId: null,
        senderDisplayName: null,
        payerId: null,
        epochNumber: 1,
        sequenceNumber: 1,
        createdAt: '2024-01-01',
      },
    ];
    mockFetchJson.mockResolvedValueOnce({ conversation: mockConversation, messages: mockMessages });

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockMessages);
  });

  it('is disabled when conversationId is empty', () => {
    const { result } = renderHook(() => useMessages(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('handles API errors', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useMessages('invalid-id'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });
});

describe('useCreateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls POST /conversations with correct body', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: 'New Chat',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      title: 'New Chat',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockResponse);
  });

  it('creates conversation without firstMessage field', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('handles API errors correctly', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-error',
      title: 'Test',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

describe('useDeleteConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls DELETE /conversations/:id', async () => {
    const mockResponse = { deleted: true };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockResponse);
  });

  it('handles 404 error when conversation already deleted', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('deleted-id');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles unauthorized error', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

describe('useUpdateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls PATCH /conversations/:id with title', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Updated Title',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: 'Updated Title', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data?.conversation.title).toBe('Updated Title');
  });

  it('handles 404 error for non-existent conversation', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'invalid-id',
      data: { title: 'New Title', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles validation error for empty title', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Title is required'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: '', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title is required');
  });

  it('handles validation error for title exceeding max length', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Title too long'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    const longTitle = 'a'.repeat(256);
    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: longTitle, titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title too long');
  });
});

describe('useDecryptedConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('shows Encrypted conversation placeholder when decryption throws', async () => {
    const mockConversations = [
      {
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64encryptedblob',
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 0,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
      },
    ];
    mockFetchJson.mockResolvedValueOnce({ conversations: mockConversations });

    // Epoch key is available so decryption path is reached
    mockGetEpochKey.mockReturnValue(new Uint8Array(32).fill(1));
    // Decryption throws (e.g., wrong key or corrupt blob)
    mockDecryptMessage.mockImplementation(() => {
      throw new Error('Decryption failed');
    });

    const { result } = renderHook(() => useDecryptedConversations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data![0]!.title).toBe('Encrypted conversation');
  });
});
