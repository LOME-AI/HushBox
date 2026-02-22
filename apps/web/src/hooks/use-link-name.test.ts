import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../lib/api-client.js', () => ({
  client: {
    api: {
      'link-guest': {
        name: { $patch: vi.fn(() => Promise.resolve(new Response())) },
      },
      links: {
        ':conversationId': {
          ':linkId': {
            name: { $patch: vi.fn(() => Promise.resolve(new Response())) },
          },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '../lib/api-client.js';
import { useGuestLinkName, useAdminLinkName } from './use-link-name.js';

const mockFetchJson = vi.mocked(fetchJson);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

let testQueryClient: QueryClient;

function createWrapperWithClient(): ({ children }: { children: ReactNode }) => ReactNode {
  testQueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: testQueryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useGuestLinkName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls fetchJson with correct path and body', async () => {
    mockFetchJson.mockResolvedValue({ success: true });

    const { result } = renderHook(() => useGuestLinkName(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: 'conv-1',
        linkPublicKey: 'pub-key-b64',
        displayName: 'Alice',
      });
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });
});

describe('useAdminLinkName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls fetchJson with correct path and body', async () => {
    mockFetchJson.mockResolvedValue({ success: true });

    const { result } = renderHook(() => useAdminLinkName(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: 'conv-1',
        linkId: 'link-1',
        displayName: 'Bob',
      });
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('invalidates links query on success', async () => {
    mockFetchJson.mockResolvedValue({ success: true });

    const wrapper = createWrapperWithClient();
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    const { result } = renderHook(() => useAdminLinkName(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: 'conv-1',
        linkId: 'link-1',
        displayName: 'Bob',
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['links'] });
    });

    invalidateSpy.mockRestore();
  });
});
