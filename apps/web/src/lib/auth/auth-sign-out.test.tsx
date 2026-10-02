import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { TEST_DAY_START, isoAt, testUuidV7 } from '@hushbox/shared/test-time';
import { createAuthServerFixture, resetAuthEnvironment } from '@/test-utils/auth-server-fixture';
import { makeBalance } from '@/test-utils/balance-fixture';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: { unregister: vi.fn(() => Promise.resolve()) },
}));

import { queryClient } from '@/providers/query-provider';
import { chatKeys, useConversation, useConversations, useMessages } from '@/hooks/chat/chat';
import { balanceQueryOptions, useBalance } from '@/hooks/billing/billing';
import { isReadLoading } from '@/lib/chat/auth-chat-helpers';
import { clearLocalAuthState, initAuth, signOutAndClearCache } from './auth';
import { persistExportKey } from './client.js';
import type { InferResponseType } from 'hono/client';
import type { GetBalanceResponse, GetConversationResponse } from '@hushbox/shared';
import type { client } from '@/lib/api-client';
import type { AuthServerFixture, AuthTestEnvironment } from '@/test-utils/auth-server-fixture';

type MessagesPage = InferResponseType<
  (typeof client.conversations)[':conversationId']['messages']['$get'],
  200
>;

type ConversationsPage = InferResponseType<typeof client.conversations.$get, 200>;

const CONVERSATION_ID = testUuidV7(100);

const CONVERSATION: GetConversationResponse = {
  conversation: {
    id: CONVERSATION_ID,
    title: '',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 1,
    createdAt: isoAt(TEST_DAY_START),
    updatedAt: isoAt(TEST_DAY_START),
  },
  membership: {
    privilege: 'owner',
    muted: false,
    pinned: false,
    accepted: true,
    visibleFromEpoch: 1,
    lastReadSeq: 0,
    linkId: null,
  },
  forks: [],
};

const MESSAGES_PAGE: MessagesPage = { messages: [], nextCursor: null };

const NEXT_PAGE_CURSOR = 'next-page';

const FIRST_OF_TWO_PAGES: MessagesPage = { messages: [], nextCursor: NEXT_PAGE_CURSOR };

const FIRST_OF_TWO_LIST_PAGES: ConversationsPage = {
  conversations: [],
  nextCursor: NEXT_PAGE_CURSOR,
};

const LAST_LIST_PAGE: ConversationsPage = { conversations: [], nextCursor: null };

const BALANCE: GetBalanceResponse = makeBalance('1000000000');

const originalLocation = globalThis.location;

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('sign-out against the real query client', () => {
  let fixture: AuthServerFixture;
  let environment: AuthTestEnvironment;
  let unmount: (() => void) | undefined;

  beforeAll(async () => {
    fixture = await createAuthServerFixture();
  });

  beforeEach(() => {
    environment = resetAuthEnvironment(fixture);
    fixture.serve(`/conversations/${CONVERSATION_ID}`, () => Response.json(CONVERSATION));
    // The typed client writes an empty query as a bare trailing `?`.
    fixture.serve(`/conversations/${CONVERSATION_ID}/messages?`, () =>
      Response.json(MESSAGES_PAGE)
    );
    fixture.serve('/billing/balance', () => Response.json(BALANCE));
    // A reload that does nothing models the window between `reload()` and the
    // new document, in which the old page's JavaScript keeps running.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: {
        href: `http://localhost/chat/${CONVERSATION_ID}`,
        origin: 'http://localhost',
        pathname: `/chat/${CONVERSATION_ID}`,
        reload: vi.fn(),
      },
    });
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    queryClient.clear();
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  async function signedIn(): Promise<void> {
    await persistExportKey(fixture.exportKey, fixture.userId, true);
    await initAuth();
  }

  /** Mounts the reads an open conversation holds, and waits for each to land. */
  async function conversationPageMounted(): Promise<void> {
    const rendered = renderHook(
      () => ({
        conversation: useConversation(CONVERSATION_ID),
        messages: useMessages(CONVERSATION_ID),
        // Enabled the way the app shell holds it: settled once from stored auth
        // at startup, and not re-read when the session ends.
        balance: useBalance({ enabled: true }),
      }),
      { wrapper }
    );
    unmount = rendered.unmount;
    await waitFor(() => {
      expect(rendered.result.current.conversation.data?.id).toBe(CONVERSATION_ID);
      expect(rendered.result.current.messages.data).toEqual([]);
      expect(rendered.result.current.balance.data).toEqual(BALANCE);
    });
  }

  /** One macrotask turn runs every queued microtask; nothing these chains await is a timer. */
  async function drainMicrotasks(): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  function requestPathsFrom(index: number): string[] {
    return fixture.requests.slice(index).map((request) => new URL(request.url).pathname);
  }

  function requestsAfterLogout(): string[] {
    const logoutAt = fixture.requests.findIndex((request) => request.url.endsWith('/auth/logout'));
    expect(logoutAt).toBeGreaterThanOrEqual(0);
    return requestPathsFrom(logoutAt + 1);
  }

  it('sends no read after the logout request while the page is reloading', async () => {
    await signedIn();
    await conversationPageMounted();

    await act(async () => {
      await signOutAndClearCache();
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });

    expect(globalThis.location.reload).toHaveBeenCalledOnce();
    expect(requestsAfterLogout()).toEqual([]);
  });

  it('sends no history page after the logout request when sign-out lands mid-load', async () => {
    let answerFirstPage: ((response: Response) => void) | undefined;
    fixture.serve(
      `/conversations/${CONVERSATION_ID}/messages?`,
      () =>
        new Promise<Response>((resolve) => {
          answerFirstPage = resolve;
        })
    );
    fixture.serve(`/conversations/${CONVERSATION_ID}/messages?cursor=${NEXT_PAGE_CURSOR}`, () =>
      Response.json(MESSAGES_PAGE)
    );
    await signedIn();
    unmount = renderHook(() => useMessages(CONVERSATION_ID), { wrapper }).unmount;
    await vi.waitFor(() => {
      expect(answerFirstPage).toBeDefined();
    });
    // Parks the sign-out after it has stopped new fetches and before it clears
    // the cache, the window in which a read already running is still loose.
    environment.indexedDb.holdDelete = true;

    const signedOut = signOutAndClearCache();
    await vi.waitFor(() => {
      expect(onlineManager.isOnline()).toBe(false);
    });
    answerFirstPage?.(Response.json(FIRST_OF_TWO_PAGES));
    await drainMicrotasks();
    environment.indexedDb.releaseDelete();
    await act(async () => {
      await signedOut;
    });
    await drainMicrotasks();

    expect(requestsAfterLogout()).toEqual([]);
  });

  it('sends no conversation-list page after the logout request when sign-out lands mid-refetch', async () => {
    let firstPageLoads = 0;
    let answerRefetchedFirstPage: ((response: Response) => void) | undefined;
    fixture.serve('/conversations?', () => {
      firstPageLoads += 1;
      if (firstPageLoads === 1) return Response.json(FIRST_OF_TWO_LIST_PAGES);
      return new Promise<Response>((resolve) => {
        answerRefetchedFirstPage = resolve;
      });
    });
    fixture.serve(`/conversations?cursor=${NEXT_PAGE_CURSOR}`, () => Response.json(LAST_LIST_PAGE));
    await signedIn();
    const rendered = renderHook(() => useConversations(), { wrapper });
    unmount = rendered.unmount;
    await waitFor(() => {
      expect(rendered.result.current.hasNextPage).toBe(true);
    });
    act(() => {
      rendered.result.current.fetchNextPage();
    });
    await waitFor(() => {
      expect(rendered.result.current.hasNextPage).toBe(false);
    });
    // An infinite query's refetch requests every loaded page in turn, in one fetch.
    void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(), exact: true });
    await vi.waitFor(() => {
      expect(answerRefetchedFirstPage).toBeDefined();
    });
    environment.indexedDb.holdDelete = true;

    const signedOut = signOutAndClearCache();
    await vi.waitFor(() => {
      expect(onlineManager.isOnline()).toBe(false);
    });
    answerRefetchedFirstPage?.(Response.json(FIRST_OF_TWO_LIST_PAGES));
    await drainMicrotasks();
    environment.indexedDb.releaseDelete();
    await act(async () => {
      await signedOut;
    });
    await drainMicrotasks();

    expect(requestsAfterLogout()).toEqual([]);
  });

  it('never reads a conversation page as missing through a sign-out', async () => {
    // The chat page renders a read with no data that is not loading as a missing
    // conversation and redirects, which the reload then interrupts mid-import.
    await signedIn();
    const readsAsMissing: boolean[] = [];
    const rendered = renderHook(
      () => {
        const conversation = useConversation(CONVERSATION_ID);
        readsAsMissing.push(conversation.data === undefined && !isReadLoading(conversation));
        return conversation;
      },
      { wrapper }
    );
    unmount = rendered.unmount;
    await waitFor(() => {
      expect(rendered.result.current.data?.id).toBe(CONVERSATION_ID);
    });
    const signOutFrom = readsAsMissing.length;

    await act(async () => {
      await signOutAndClearCache();
    });
    await act(drainMicrotasks);

    expect(rendered.result.current.data).toBeUndefined();
    expect(readsAsMissing.slice(signOutFrom)).not.toContain(true);
  });

  it('sends no read after the clear an account deletion makes on its way out', async () => {
    await signedIn();
    await conversationPageMounted();
    const clearedAt = fixture.requests.length;

    await act(async () => {
      await clearLocalAuthState({ next: 'navigate-away' });
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });

    expect(globalThis.location.reload).not.toHaveBeenCalled();
    expect(requestPathsFrom(clearedAt)).toEqual([]);
  });

  it('lets queries fetch after a switch-user sign-out', async () => {
    await signedIn();

    await clearLocalAuthState({ next: 'switch-user' });
    const balance = queryClient.fetchQuery(balanceQueryOptions());

    await vi.waitFor(() => {
      expect(fixture.requestsTo('/billing/balance')).toHaveLength(1);
    });
    await expect(balance).resolves.toEqual(BALANCE);
  });
});
