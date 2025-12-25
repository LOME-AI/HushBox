/* eslint-disable @typescript-eslint/unbound-method -- vitest mocks are self-bound */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { chatKeys, useConversations, useConversation, useMessages } from './chat';

// Mock the api module
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../lib/api';

const mockApi = vi.mocked(api);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
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
      },
    ];
    mockApi.get.mockResolvedValueOnce({ conversations: mockConversations });

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledWith('/conversations');
    expect(result.current.data).toEqual(mockConversations);
  });

  it('handles API errors', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('Network error'));

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
    mockApi.get.mockResolvedValueOnce({ conversation: mockConversation, messages: mockMessages });

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledWith('/conversations/conv-1');
    expect(result.current.data).toEqual(mockConversation);
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useConversation(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApi.get).not.toHaveBeenCalled();
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
        role: 'user',
        content: 'Hello',
        createdAt: '2024-01-01',
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hi!',
        createdAt: '2024-01-01',
      },
    ];
    mockApi.get.mockResolvedValueOnce({ conversation: mockConversation, messages: mockMessages });

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledWith('/conversations/conv-1');
    expect(result.current.data).toEqual(mockMessages);
  });

  it('is disabled when conversationId is empty', () => {
    const { result } = renderHook(() => useMessages(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('handles API errors', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useMessages('invalid-id'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });
});
