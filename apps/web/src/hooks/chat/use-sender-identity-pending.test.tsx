import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { chatKeys } from '@/hooks/chat/chat';
import { linkKeys } from '@/hooks/realtime/use-conversation-links';
import { memberKeys } from '@/hooks/realtime/use-conversation-members';
import { useSenderIdentityPending } from '@/hooks/chat/use-sender-identity-pending';
import type { GetConversationResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { client } from '@/lib/api-client';

type Conversations = (typeof client.conversations)[':conversationId'];
type MembersBody = InferResponseType<Conversations['members']['$get'], 200>;
type LinksBody = InferResponseType<Conversations['links']['$get'], 200>;

const CONVERSATION_ID = 'conv-1';

function detailOf(memberCount: number): GetConversationResponse {
  return {
    conversation: {
      id: CONVERSATION_ID,
      title: 'title',
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
    memberCount,
  };
}

const MEMBERS: MembersBody = {
  members: [
    {
      id: 'seat-1',
      userId: 'user-1',
      linkId: null,
      username: 'alice',
      privilege: 'owner',
      visibleFromEpoch: 1,
      joinedAt: isoAt(TEST_DAY_START),
      accepted: true,
    },
  ],
};

const LINKS: LinksBody = { links: [] };

/** How the stub answers one read: never, with its body, or with a server error. */
type Answer = 'pending' | 'failed' | { readonly body: unknown };

interface Answers {
  conversation: Answer;
  members: Answer;
  links: Answer;
}

let answers: Answers;
let mockFetch: Mock<typeof fetch>;
let queryClient: QueryClient;

function answerFor(url: string): Answer {
  if (url.includes('/members')) return answers.members;
  if (url.includes('/links')) return answers.links;
  return answers.conversation;
}

async function respond(answer: Answer): Promise<Response> {
  if (answer === 'pending') return await new Promise<Response>(() => {});
  if (answer === 'failed') return Response.json({ code: 'INTERNAL' }, { status: 500 });
  return Response.json(answer.body);
}

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function requestedUrls(): string[] {
  return mockFetch.mock.calls.map(([input]) => urlFromFetchInput(input));
}

beforeEach(() => {
  // A failed read is retried after a long delay, so a test sees it between its first failure
  // and its final one.
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 3, retryDelay: 60 * SECOND_MS } },
  });
  answers = { conversation: { body: detailOf(3) }, members: 'pending', links: 'pending' };
  mockFetch = vi.fn<typeof fetch>((input) => respond(answerFor(urlFromFetchInput(input))));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(async () => {
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function settledHook(conversationId?: string): Promise<{ current: boolean }> {
  const { result } = renderHook(() => useSenderIdentityPending(conversationId), { wrapper });
  if (conversationId !== undefined) {
    await waitFor(() => {
      expect(queryClient.getQueryState(chatKeys.conversation(conversationId))?.status).not.toBe(
        'pending'
      );
    });
  }
  return result;
}

describe('useSenderIdentityPending', () => {
  it('is pending while a group conversation has its members read outstanding', async () => {
    answers.links = { body: LINKS };
    const result = await settledHook(CONVERSATION_ID);

    expect(result.current).toBe(true);
  });

  it('is pending while a group conversation has its links read outstanding', async () => {
    answers.members = { body: MEMBERS };
    const result = await settledHook(CONVERSATION_ID);

    expect(result.current).toBe(true);
  });

  it('settles once both the members read and the links read have landed', async () => {
    answers.members = { body: MEMBERS };
    answers.links = { body: LINKS };
    const result = await settledHook(CONVERSATION_ID);

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it('settles once the members read has failed once, before its retries end', async () => {
    answers.members = 'failed';
    answers.links = { body: LINKS };
    const result = await settledHook(CONVERSATION_ID);

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
    expect(queryClient.getQueryState(memberKeys.list(CONVERSATION_ID))?.status).toBe('pending');
  });

  it('settles once the links read has failed once, before its retries end', async () => {
    answers.members = { body: MEMBERS };
    answers.links = 'failed';
    const result = await settledHook(CONVERSATION_ID);

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
    expect(queryClient.getQueryState(linkKeys.list(CONVERSATION_ID))?.status).toBe('pending');
  });

  it('never holds a conversation of one member', async () => {
    answers.conversation = { body: detailOf(1) };
    const result = await settledHook(CONVERSATION_ID);

    expect(result.current).toBe(false);
  });

  it('never holds while the conversation read has not said how many members there are', () => {
    answers.conversation = 'pending';
    const { result } = renderHook(() => useSenderIdentityPending(CONVERSATION_ID), { wrapper });

    expect(result.current).toBe(false);
  });

  it('never holds without a conversation', async () => {
    const result = await settledHook();

    expect(result.current).toBe(false);
  });

  it('asks nothing without a conversation', async () => {
    await settledHook();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reads only through the conversation, members and links query keys', async () => {
    await settledHook(CONVERSATION_ID);

    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey)
    ).toEqual(
      expect.arrayContaining([
        chatKeys.conversation(CONVERSATION_ID),
        memberKeys.list(CONVERSATION_ID),
        linkKeys.list(CONVERSATION_ID),
      ])
    );
    expect(queryClient.getQueryCache().getAll()).toHaveLength(3);
  });

  it('asks only the conversation, members and links reads', async () => {
    await settledHook(CONVERSATION_ID);

    expect(requestedUrls().map((url) => new URL(url).pathname)).toEqual(
      expect.arrayContaining([
        `/conversations/${CONVERSATION_ID}`,
        `/conversations/${CONVERSATION_ID}/members`,
        `/conversations/${CONVERSATION_ID}/links`,
      ])
    );
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
