import * as React from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { chatKeys } from '@/hooks/chat/chat';
import { linkKeys } from '@/hooks/realtime/use-conversation-links';
import { memberKeys } from '@/hooks/realtime/use-conversation-members';
import { useAuthStore } from '@/lib/auth/auth';
import { useReplyingToName } from './use-replying-to-name';
import type { ConversationDetailResponse } from '@/hooks/chat/chat';
import type { Message } from '@/lib/api/api';
import type { ConversationLinksData, ConversationMembersData } from './use-replying-to-name';
import type { MessageResponse } from '@hushbox/shared';

type SessionUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;

const CONVERSATION_ID = 'conv-1';
const ALICE_ID = 'user-alice';
const BOB_ID = 'user-bob';
const LINK_ID = 'link-luisa';

const ALICE: SessionUser = {
  id: ALICE_ID,
  email: 'alice@hushbox.ai',
  username: 'Alice',
  emailVerified: true,
  totpEnabled: false,
  hasAcknowledgedPhrase: true,
};

function member(
  id: string,
  userId: string | null,
  username: string | null,
  linkId: string | null
): ConversationMembersData['members'][number] {
  return {
    id,
    userId,
    linkId,
    username,
    privilege: 'write',
    visibleFromEpoch: 1,
    joinedAt: isoAt(TEST_DAY_START),
    accepted: true,
  };
}

const GROUP_MEMBERS: ConversationMembersData = {
  members: [member('m-alice', ALICE_ID, 'Alice', null), member('m-bob', BOB_ID, 'Bob', null)],
};

const SOLO_MEMBERS: ConversationMembersData = {
  members: [member('m-alice', ALICE_ID, 'Alice', null)],
};

const LINKS: ConversationLinksData = {
  links: [
    {
      id: LINK_ID,
      displayName: 'Luísa',
      privilege: 'write',
      revokedAt: null,
      expiresAt: null,
      createdAt: isoAt(TEST_DAY_START),
    },
  ],
};

const NO_LINKS: ConversationLinksData = { links: [] };

function conversation(linkId: string | null): ConversationDetailResponse {
  return {
    conversation: {
      id: CONVERSATION_ID,
      title: 'encrypted-title',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 3,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
    },
    membership: {
      privilege: 'write',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
      lastReadSeq: 0,
      linkId,
    },
    forks: [],
  };
}

function stored(id: string, senderId: string | null, parent: string | null): MessageResponse {
  return {
    id,
    parentMessageId: parent,
    sequenceNumber: 1,
    epochNumber: 1,
    senderType: senderId === null ? 'assistant' : 'user',
    senderId,
    wrappedContentKey: 'wrapped',
    batchId: 'batch-1',
    deleted: false,
    createdAt: isoAt(TEST_DAY_START),
    contentItems: [],
  };
}

const REPLY: Message = {
  id: 'reply-1',
  conversationId: CONVERSATION_ID,
  role: 'assistant',
  content: 'An answer.',
  createdAt: isoAt(TEST_DAY_START),
  parentMessageId: 'ask-1',
};

interface Caches {
  readonly members: ConversationMembersData;
  readonly links: ConversationLinksData;
  readonly askedBy: string;
  readonly viewerLinkId?: string;
}

function nameFor(caches: Caches, message: Message = REPLY): string | undefined {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(
    chatKeys.conversation(CONVERSATION_ID),
    conversation(caches.viewerLinkId ?? null)
  );
  queryClient.setQueryData(chatKeys.messages(CONVERSATION_ID), [
    stored('ask-1', caches.askedBy, null),
    stored('reply-1', null, 'ask-1'),
  ]);
  queryClient.setQueryData(memberKeys.list(CONVERSATION_ID), caches.members);
  queryClient.setQueryData(linkKeys.list(CONVERSATION_ID), caches.links);
  function Wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return renderHook(() => useReplyingToName(message), { wrapper: Wrapper }).result.current;
}

beforeEach(() => {
  useAuthStore.setState({ user: null });
});

describe('useReplyingToName', () => {
  it('names the member a group reply answers', () => {
    useAuthStore.setState({ user: ALICE });
    expect(nameFor({ members: GROUP_MEMBERS, links: NO_LINKS, askedBy: BOB_ID })).toBe('Bob');
  });

  it("says 'you' for a reply to the viewer's own message", () => {
    useAuthStore.setState({ user: ALICE });
    expect(nameFor({ members: GROUP_MEMBERS, links: NO_LINKS, askedBy: ALICE_ID })).toBe('you');
  });

  it('names nobody in a solo chat', () => {
    useAuthStore.setState({ user: ALICE });
    expect(nameFor({ members: SOLO_MEMBERS, links: NO_LINKS, askedBy: ALICE_ID })).toBeUndefined();
  });

  it('names a link guest a reply answers', () => {
    useAuthStore.setState({ user: ALICE });
    expect(nameFor({ members: SOLO_MEMBERS, links: LINKS, askedBy: LINK_ID })).toBe('Luísa');
  });

  it("says 'you' to a link guest on the shared conversation for its own message", () => {
    expect(
      nameFor({ members: GROUP_MEMBERS, links: LINKS, askedBy: LINK_ID, viewerLinkId: LINK_ID })
    ).toBe('you');
  });

  it('names the member for a link guest on the shared conversation', () => {
    expect(
      nameFor({ members: GROUP_MEMBERS, links: LINKS, askedBy: BOB_ID, viewerLinkId: LINK_ID })
    ).toBe('Bob');
  });

  it("names a link guest through its link, not through the guest's member row", () => {
    useAuthStore.setState({ user: ALICE });
    const withGuestRow: ConversationMembersData = {
      members: [...SOLO_MEMBERS.members, member('m-guest', null, null, LINK_ID)],
    };
    expect(nameFor({ members: withGuestRow, links: LINKS, askedBy: LINK_ID })).toBe('Luísa');
  });

  it("names a group reply's member before the links have been read", () => {
    useAuthStore.setState({ user: ALICE });
    const queryClient = new QueryClient();
    queryClient.setQueryData(chatKeys.conversation(CONVERSATION_ID), conversation(null));
    queryClient.setQueryData(chatKeys.messages(CONVERSATION_ID), [stored('ask-1', BOB_ID, null)]);
    queryClient.setQueryData(memberKeys.list(CONVERSATION_ID), GROUP_MEMBERS);
    function Wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useReplyingToName(REPLY), { wrapper: Wrapper });
    expect(result.current).toBe('Bob');
  });

  it('names the asker in a group whose second member has no name to give', () => {
    useAuthStore.setState({ user: ALICE });
    const withNamelessMember: ConversationMembersData = {
      members: [...SOLO_MEMBERS.members, member('m-gone', 'user-gone', null, null)],
    };
    expect(nameFor({ members: withNamelessMember, links: NO_LINKS, askedBy: ALICE_ID })).toBe(
      'you'
    );
  });

  it("names the asker once the conversation's reads land after the reply has mounted", async () => {
    useAuthStore.setState({ user: ALICE });
    const queryClient = new QueryClient();
    function Wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useReplyingToName(REPLY), { wrapper: Wrapper });
    expect(result.current).toBeUndefined();

    await act(async () => {
      queryClient.setQueryData(memberKeys.list(CONVERSATION_ID), GROUP_MEMBERS);
      queryClient.setQueryData(chatKeys.messages(CONVERSATION_ID), [stored('ask-1', BOB_ID, null)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current).toBe('Bob');
  });

  it('names nobody before the conversation it belongs to has been read', () => {
    useAuthStore.setState({ user: ALICE });
    const queryClient = new QueryClient();
    function Wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useReplyingToName(REPLY), { wrapper: Wrapper });
    expect(result.current).toBeUndefined();
  });

  it('names nobody for a reply whose asker is not in the stored history', () => {
    useAuthStore.setState({ user: ALICE });
    expect(
      nameFor(
        { members: GROUP_MEMBERS, links: NO_LINKS, askedBy: BOB_ID },
        { ...REPLY, parentMessageId: 'optimistic-ask' }
      )
    ).toBeUndefined();
  });

  it('names nobody for a reply to a message no user sent', () => {
    useAuthStore.setState({ user: ALICE });
    expect(
      nameFor(
        { members: GROUP_MEMBERS, links: NO_LINKS, askedBy: BOB_ID },
        { ...REPLY, parentMessageId: 'reply-1' }
      )
    ).toBeUndefined();
  });
});

describe('useReplyingToName beside the page that owns the reads', () => {
  it("leaves the page's own history refetch working", async () => {
    useAuthStore.setState({ user: ALICE });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let fetches = 0;
    function usePageHistory(): unknown {
      return useQuery({
        queryKey: chatKeys.messages(CONVERSATION_ID),
        queryFn: () => {
          fetches += 1;
          return Promise.resolve([stored('ask-1', BOB_ID, null)]);
        },
      });
    }
    function Wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    renderHook(
      () => {
        usePageHistory();
        return useReplyingToName(REPLY);
      },
      { wrapper: Wrapper }
    );
    await waitFor(() => {
      expect(fetches).toBe(1);
    });

    await queryClient.invalidateQueries({ queryKey: chatKeys.messages(CONVERSATION_ID) });

    expect(fetches).toBe(2);
    expect(queryClient.getQueryState(chatKeys.messages(CONVERSATION_ID))?.error).toBeNull();
  });
});

describe('useReplyingToName beside a component that creates a read during its render', () => {
  it('updates the reply only after the creating component has rendered', async () => {
    useAuthStore.setState({ user: ALICE });
    const consoleError = vi.spyOn(console, 'error');
    onTestFinished(() => {
      consoleError.mockRestore();
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(chatKeys.conversation(CONVERSATION_ID), conversation(null));
    queryClient.setQueryData(chatKeys.messages(CONVERSATION_ID), [stored('ask-1', BOB_ID, null)]);
    function Reply(): React.JSX.Element {
      return <>{useReplyingToName(REPLY)}</>;
    }
    function MemberList(): null {
      useQuery({
        queryKey: memberKeys.list(CONVERSATION_ID),
        queryFn: () => Promise.resolve(GROUP_MEMBERS),
        initialData: GROUP_MEMBERS,
      });
      return null;
    }
    function Page({ showMembers }: Readonly<{ showMembers: boolean }>): React.JSX.Element {
      return (
        <QueryClientProvider client={queryClient}>
          <Reply />
          {showMembers && <MemberList />}
        </QueryClientProvider>
      );
    }
    const { container, rerender } = render(<Page showMembers={false} />);
    expect(container).toHaveTextContent(/^$/);

    rerender(<Page showMembers />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container).toHaveTextContent(/^Bob$/);
    const logged = consoleError.mock.calls.map(([message]) => String(message));
    expect(logged.filter((message) => message.includes('Cannot update a component'))).toEqual([]);
  });
});
