import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { useNamingReads } from '@/lib/chat/use-naming-reads';
import type { InferResponseType } from 'hono/client';
import type { client } from '@/lib/api-client';

type Conversations = (typeof client.conversations)[':conversationId'];
type MembersBody = InferResponseType<Conversations['members']['$get'], 200>;
type LinksBody = InferResponseType<Conversations['links']['$get'], 200>;

const ROSTER: MembersBody['members'] = [
  {
    id: 'seat-a',
    userId: null,
    linkId: 'link-a',
    username: null,
    privilege: 'write',
    visibleFromEpoch: 1,
    joinedAt: isoAt(TEST_DAY_START),
    accepted: true,
  },
];

const LINKS: LinksBody['links'] = [
  {
    id: 'link-a',
    displayName: 'Luísa',
    privilege: 'write',
    revokedAt: null,
    expiresAt: null,
    createdAt: isoAt(TEST_DAY_START),
  },
];

let mockFetch: Mock<typeof fetch>;

function respond(url: string): Response {
  if (url.includes('/members')) return Response.json({ members: ROSTER });
  if (url.includes('/links')) return Response.json({ links: LINKS });
  return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
}

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockFetch = vi.fn<typeof fetch>((input) => Promise.resolve(respond(urlFromFetchInput(input))));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('useNamingReads', () => {
  it("reads the conversation's roster", async () => {
    const { result } = renderHook(() => useNamingReads('conv-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.roster).toEqual(ROSTER);
    });
  });

  it("reads the conversation's links", async () => {
    const { result } = renderHook(() => useNamingReads('conv-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.links).toEqual(LINKS);
    });
  });

  it('holds empty lists without a conversation', () => {
    const { result } = renderHook(() => useNamingReads(null), { wrapper });

    expect(result.current).toEqual({ roster: [], links: [] });
  });

  it('asks nothing without a conversation', () => {
    renderHook(() => useNamingReads(null), { wrapper });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns the same reads across renders while neither read changes', async () => {
    const { result, rerender } = renderHook(() => useNamingReads('conv-1'), { wrapper });
    await waitFor(() => {
      expect(result.current.links).toEqual(LINKS);
    });
    await waitFor(() => {
      expect(result.current.roster).toEqual(ROSTER);
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
