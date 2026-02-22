import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDeriveKeysFromLinkSecret =
  vi.fn<(secret: Uint8Array) => { publicKey: Uint8Array; privateKey: Uint8Array }>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();
const mockToBase64 = vi.fn<(data: Uint8Array) => string>();

vi.mock('@hushbox/crypto', () => ({
  deriveKeysFromLinkSecret: (secret: Uint8Array) => mockDeriveKeysFromLinkSecret(secret),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => mockFromBase64(b64),
    toBase64: (data: Uint8Array) => mockToBase64(data),
  };
});

vi.mock('../lib/api-client.js', () => ({
  client: {
    api: {
      'link-guest': {
        access: { $post: vi.fn(() => Promise.resolve(new Response())) },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '../lib/api-client.js';
import { useSharedConversation } from './use-shared-conversation.js';

const mockFetchJson = vi.mocked(fetchJson);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

const FAKE_RESPONSE = {
  conversation: { id: 'conv-1', title: 'Test', currentEpoch: 1, titleEpochNumber: 1 },
  privilege: 'read',
  wraps: [
    {
      epochNumber: 1,
      wrap: 'wrapped',
      confirmationHash: 'hash',
      privilege: 'read',
      visibleFromEpoch: 1,
    },
  ],
  chainLinks: [],
  messages: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSharedConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromBase64.mockImplementation((b64: string) => new TextEncoder().encode(b64));
    mockToBase64.mockImplementation(() => 'derived-pub-key-base64');
    mockDeriveKeysFromLinkSecret.mockImplementation(() => ({
      publicKey: new Uint8Array([1, 2, 3]),
      privateKey: new Uint8Array([4, 5, 6]),
    }));
    mockFetchJson.mockResolvedValue(FAKE_RESPONSE);
  });

  it('is disabled when conversationId is null', () => {
    const { result } = renderHook(() => useSharedConversation(null, 'some-private-key'), {
      wrapper: createWrapper(),
    });

    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('is disabled when linkPrivateKeyBase64 is null', () => {
    const { result } = renderHook(() => useSharedConversation('conv-1', null), {
      wrapper: createWrapper(),
    });

    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('derives keys via deriveKeysFromLinkSecret and calls fetchJson with correct params', async () => {
    const secretBytes = new Uint8Array([10, 20, 30]);
    const publicKeyBytes = new Uint8Array([40, 50, 60]);
    const privateKeyBytes = new Uint8Array([70, 80, 90]);
    mockFromBase64.mockReturnValue(secretBytes);
    mockDeriveKeysFromLinkSecret.mockReturnValue({
      publicKey: publicKeyBytes,
      privateKey: privateKeyBytes,
    });
    mockToBase64.mockReturnValue('pub-key-b64');
    mockFetchJson.mockResolvedValue(FAKE_RESPONSE);

    const { result } = renderHook(() => useSharedConversation('conv-1', 'priv-key-b64'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(FAKE_RESPONSE);
    });

    expect(mockFromBase64).toHaveBeenCalledWith('priv-key-b64');
    expect(mockDeriveKeysFromLinkSecret).toHaveBeenCalledWith(secretBytes);
    expect(mockToBase64).toHaveBeenCalledWith(publicKeyBytes);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('returns linkPrivateKey from derived keys', async () => {
    const privateKeyBytes = new Uint8Array([70, 80, 90]);
    mockDeriveKeysFromLinkSecret.mockReturnValue({
      publicKey: new Uint8Array([40, 50, 60]),
      privateKey: privateKeyBytes,
    });
    mockFetchJson.mockResolvedValue(FAKE_RESPONSE);

    const { result } = renderHook(() => useSharedConversation('conv-1', 'priv-key-b64'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(FAKE_RESPONSE);
    });

    expect(result.current.linkPrivateKey).toEqual(privateKeyBytes);
  });

  it('returns null linkPrivateKey when linkPrivateKeyBase64 is null', () => {
    const { result } = renderHook(() => useSharedConversation('conv-1', null), {
      wrapper: createWrapper(),
    });

    expect(result.current.linkPrivateKey).toBeNull();
  });

  it('has staleTime Infinity', async () => {
    const { result } = renderHook(() => useSharedConversation('conv-1', 'priv-key-b64'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(FAKE_RESPONSE);
    });

    // After data is fetched, dataUpdatedAt should exist and stale should be false
    // With Infinity staleTime, the query should never be considered stale
    expect(result.current.isStale).toBe(false);
  });
});
