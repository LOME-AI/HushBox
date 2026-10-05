import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { SECOND_MS, TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

// The list stands in for itself: what this file pins is when the host mounts it, and which
// sender identity it hands the list on that mount.
const { list } = vi.hoisted(() => ({
  list: {
    renders: [] as { isGroupChat: boolean | undefined; senders: string[] }[],
    mounts: 0,
    reveal: undefined as ((revealed: boolean) => void) | undefined,
  },
}));
vi.mock('@/components/chat/message/message-list', () => ({
  MessageList: function MessageListStub({
    isGroupChat,
    members,
    onRevealedChange,
  }: Readonly<
    Pick<React.ComponentProps<typeof MessageList>, 'isGroupChat' | 'members' | 'onRevealedChange'>
  >): React.JSX.Element {
    list.reveal = onRevealedChange;
    list.renders.push({
      isGroupChat,
      senders: (members ?? []).map((member) => member.username),
    });
    React.useEffect(() => {
      list.mounts += 1;
    }, []);
    return <div data-testid="message-list-stub" />;
  },
}));

// A group opens the realtime socket; no socket server exists here.
vi.mock(import('@/hooks/realtime/use-conversation-websocket'), () => ({
  useConversationWebSocket: () => null,
}));

vi.mock(import('@tanstack/react-router'), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));

import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { ChatMainContent } from '@/components/chat/layout/chat-main-content';
import { chatKeys, conversationQueryOptions } from '@/hooks/chat/chat';
import { memberKeys } from '@/hooks/realtime/use-conversation-members';
import { useGroupChat } from '@/hooks/realtime/use-group-chat';
import type { GetConversationResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { client } from '@/lib/api-client';
import type { Message } from '@/lib/api/api';
import type { MessageList, MessageListHandle } from '@/components/chat/message/message-list';

type Conversations = (typeof client.conversations)[':conversationId'];
type MembersBody = InferResponseType<Conversations['members']['$get'], 200>;
type LinksBody = InferResponseType<Conversations['links']['$get'], 200>;
type MemberRow = MembersBody['members'][number];

const VIEWER_ID = 'u1';

function detailOf(conversationId: string, memberCount: number): GetConversationResponse {
  return {
    conversation: {
      id: conversationId,
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

function seat(id: string, userId: string | null, username: string | null): MemberRow {
  return {
    id,
    userId,
    linkId: userId === null ? 'link-1' : null,
    username,
    privilege: userId === VIEWER_ID ? 'owner' : 'write',
    visibleFromEpoch: 1,
    joinedAt: isoAt(TEST_DAY_START),
    accepted: true,
  };
}

const ACCOUNT_GROUP: MembersBody = {
  members: [seat('m1', VIEWER_ID, 'alice'), seat('m2', 'u2', 'mallory'), seat('m3', 'u3', 'bob')],
};

/** A group made by a link: the owner's seat and the seat its guest joined through. */
const LINK_GROUP: MembersBody = {
  members: [seat('m1', VIEWER_ID, 'alice'), seat('m2', null, null)],
};

const NO_LINKS: LinksBody = { links: [] };

const GUEST_LINK: LinksBody = {
  links: [
    {
      id: 'link-1',
      displayName: 'Guest',
      privilege: 'write',
      revokedAt: null,
      expiresAt: null,
      createdAt: isoAt(TEST_DAY_START),
    },
  ],
};

/**
 * How the stub answers one read: never, with its body, with a server error, or with its body
 * once a gate the test holds opens.
 */
type Answer =
  | 'pending'
  | 'failed'
  | { readonly body: unknown }
  | { readonly body: unknown; readonly gate: Promise<void> };

/** A gate the test opens, and the call that opens it. */
function heldGate(): { gate: Promise<void>; open: () => void } {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

interface Answers {
  conversation: Answer;
  members: Answer;
  links: Answer;
}

let answers: Map<string, Answers>;
let mockFetch: Mock<typeof fetch>;
let queryClient: QueryClient;

/** What a conversation the test set no answers for answers to every read. */
const UNANSWERED: Answers = { conversation: 'failed', members: 'failed', links: 'failed' };

function readOf(segment: string | undefined): keyof Answers {
  if (segment === 'members' || segment === 'links') return segment;
  return 'conversation';
}

function answerFor(url: string): Answer {
  const segments = new URL(url).pathname.split('/');
  const answered = answers.get(segments[2] ?? '') ?? UNANSWERED;
  return answered[readOf(segments[3])];
}

async function respond(answer: Answer): Promise<Response> {
  if (answer === 'pending') return await new Promise<Response>(() => {});
  if (answer === 'failed') return Response.json({ code: 'INTERNAL' }, { status: 500 });
  if ('gate' in answer) await answer.gate;
  return Response.json(answer.body);
}

function answerAll(conversationId: string, answered: Answers): void {
  answers.set(conversationId, answered);
}

const MESSAGES: Message[] = [
  {
    id: 'msg-own',
    conversationId: 'conv-1',
    role: 'user',
    content: 'From the viewer',
    createdAt: isoAt(TEST_DAY_START),
    senderId: VIEWER_ID,
  },
  {
    id: 'msg-other',
    conversationId: 'conv-1',
    role: 'user',
    content: 'From another member',
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
    senderId: 'u2',
  },
];

const NO_STREAMS = new Set<string>();
const NO_MESSAGES: Message[] = [];

/**
 * The chat page's side of the thread: it reads the conversation and the group, and has no
 * messages to show, only the decrypting state, until the conversation read has landed. A
 * thread can also be handed its messages before that read lands, or still be decrypting
 * them after it.
 */
function Thread({
  conversationId,
  messagesBeforeConversation = false,
  stillDecrypting = false,
}: Readonly<{
  conversationId: string;
  messagesBeforeConversation?: boolean;
  stillDecrypting?: boolean;
}>): React.JSX.Element {
  const { data: detail } = useQuery(conversationQueryOptions(conversationId));
  const groupChat = useGroupChat(conversationId, VIEWER_ID);
  const virtuosoRef = React.useRef<MessageListHandle>(null);
  const onShare = React.useCallback((_messageId: string): void => {}, []);
  const ready = !stillDecrypting && (messagesBeforeConversation || detail !== undefined);
  return (
    <ChatMainContent
      messages={ready ? MESSAGES : NO_MESSAGES}
      streamingMessageIds={NO_STREAMS}
      persistingMessageIds={undefined}
      errorMessageId={undefined}
      modelName="gpt-4o"
      onShare={onShare}
      onRegenerate={undefined}
      onEdit={undefined}
      onFork={undefined}
      isDecrypting={!ready}
      groupChat={groupChat}
      virtuosoRef={virtuosoRef}
      isAuthenticated={true}
      isLinkGuest={false}
      callerPrivilege="owner"
      conversationId={conversationId}
      activeForkId={null}
      messagesReady={ready}
      threadHeader={undefined}
      threadFooter={undefined}
    />
  );
}

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderThread(
  conversationId = 'conv-1',
  messagesBeforeConversation = false
): ReturnType<typeof render> {
  return render(
    <Thread
      conversationId={conversationId}
      messagesBeforeConversation={messagesBeforeConversation}
    />,
    { wrapper }
  );
}

function listShown(): boolean {
  return screen.queryByTestId('message-list-stub') !== null;
}

function placeholderShown(): boolean {
  return screen.queryByTestId(TEST_IDS.sharedConversationLoading) !== null;
}

async function conversationReadLanded(conversationId = 'conv-1'): Promise<void> {
  await waitFor(() => {
    expect(queryClient.getQueryState(chatKeys.conversation(conversationId))?.status).toBe(
      'success'
    );
  });
}

async function readAskedTimes(path: string, times: number): Promise<void> {
  await waitFor(() => {
    expect(
      mockFetch.mock.calls.filter(([input]) => new URL(urlFromFetchInput(input)).pathname === path)
    ).toHaveLength(times);
  });
}

beforeEach(() => {
  list.renders = [];
  list.mounts = 0;
  list.reveal = undefined;
  // A failed read is retried after a long delay, so a test sees it between its first failure
  // and its final one.
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 3, retryDelay: 60 * SECOND_MS } },
  });
  answers = new Map();
  mockFetch = vi.fn<typeof fetch>((input) => respond(answerFor(urlFromFetchInput(input))));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(async () => {
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe("the thread of a group whose senders' names are still being read", () => {
  it("keeps the list unmounted and the thread covered while a group conversation's members read is pending", async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: 'pending',
      links: { body: NO_LINKS },
    });
    renderThread();
    await conversationReadLanded();

    expect(listShown()).toBe(false);
    expect(placeholderShown()).toBe(true);
  });

  it('keeps it covered while a group made by a link waits for its links read', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 2) },
      members: { body: LINK_GROUP },
      links: 'pending',
    });
    renderThread();
    await conversationReadLanded();
    await waitFor(() => {
      expect(queryClient.getQueryState(memberKeys.list('conv-1'))?.status).toBe('success');
    });

    expect(listShown()).toBe(false);
    expect(placeholderShown()).toBe(true);
  });

  it('mounts the list with sender labels in its first render once both reads land', async () => {
    const members = heldGate();
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: { body: ACCOUNT_GROUP, gate: members.gate },
      links: { body: NO_LINKS },
    });
    renderThread();
    await conversationReadLanded();

    members.open();
    await waitFor(() => {
      expect(listShown()).toBe(true);
    });

    expect(list.renders[0]).toEqual({ isGroupChat: true, senders: ['alice', 'mallory', 'bob'] });
  });

  it('mounts the list naming a link guest in its first render once a link group lands', async () => {
    const links = heldGate();
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 2) },
      members: { body: LINK_GROUP },
      links: { body: GUEST_LINK, gate: links.gate },
    });
    renderThread();
    await conversationReadLanded();

    links.open();
    await waitFor(() => {
      expect(listShown()).toBe(true);
    });

    expect(list.renders[0]?.isGroupChat).toBe(true);
  });

  it('mounts at once for a conversation of one member', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 1) },
      members: 'pending',
      links: 'pending',
    });
    renderThread();
    await conversationReadLanded();

    expect(listShown()).toBe(true);
  });

  it('mounts once the members read has failed once', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: 'failed',
      links: { body: NO_LINKS },
    });
    renderThread();

    await waitFor(() => {
      expect(listShown()).toBe(true);
    });
    expect(queryClient.getQueryState(memberKeys.list('conv-1'))?.status).toBe('pending');
  });

  it('keeps a mounted list mounted when a failed members read is asked again', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: 'failed',
      links: { body: NO_LINKS },
    });
    renderThread();
    await waitFor(() => {
      expect(listShown()).toBe(true);
    });

    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: 'pending',
      links: { body: NO_LINKS },
    });
    await act(async () => {
      await queryClient.cancelQueries({ queryKey: memberKeys.list('conv-1') });
      void queryClient.refetchQueries({ queryKey: memberKeys.list('conv-1') });
    });
    await readAskedTimes('/conversations/conv-1/members', 2);

    expect(listShown()).toBe(true);
    expect(list.mounts).toBe(1);
  });

  it('keeps a mounted list mounted when the conversation read names a group after it opened', async () => {
    answerAll('conv-1', {
      conversation: 'pending',
      members: 'pending',
      links: 'pending',
    });
    renderThread('conv-1', true);
    expect(listShown()).toBe(true);
    const rendersBefore = list.renders.length;

    act(() => {
      queryClient.setQueryData(chatKeys.conversation('conv-1'), detailOf('conv-1', 3));
    });
    // The host re-renders the list once the count reaches it.
    await waitFor(() => {
      expect(list.renders.length).toBeGreaterThan(rendersBefore);
    });

    expect(listShown()).toBe(true);
    expect(list.mounts).toBe(1);
  });

  it('holds a group conversation opened after another in the same host', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: { body: ACCOUNT_GROUP },
      links: { body: NO_LINKS },
    });
    answerAll('conv-2', {
      conversation: { body: detailOf('conv-2', 3) },
      members: 'pending',
      links: { body: NO_LINKS },
    });
    const { rerender } = renderThread();
    await waitFor(() => {
      expect(listShown()).toBe(true);
    });

    rerender(<Thread conversationId="conv-2" messagesBeforeConversation={false} />);
    await conversationReadLanded('conv-2');

    expect(listShown()).toBe(false);
    expect(placeholderShown()).toBe(true);
  });
  it('covers the thread of a group opened after a revealed one while its senders are read', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: { body: ACCOUNT_GROUP },
      links: { body: NO_LINKS },
    });
    answerAll('conv-2', {
      conversation: { body: detailOf('conv-2', 3) },
      members: 'pending',
      links: { body: NO_LINKS },
    });
    const { rerender } = renderThread();
    await waitFor(() => {
      expect(listShown()).toBe(true);
    });
    act(() => {
      list.reveal?.(true);
    });
    expect(placeholderShown()).toBe(false);

    rerender(<Thread conversationId="conv-2" messagesBeforeConversation={false} />);
    await conversationReadLanded('conv-2');

    expect(placeholderShown()).toBe(true);
  });
});

describe('the hold on a group thread whose senders are never read', () => {
  const HOLD_CAP_MS = 2 * SECOND_MS;

  // Fake timeouts only: the stubbed responses still settle on the real event loop.
  beforeEach(() => {
    freezeClock(TEST_DAY_START, { toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  /** Lets every answered read land and the host re-render, without moving the clock. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      });
    }
  }

  async function elapse(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
  }

  it('mounts the list two seconds after the thread is ready when its members read never answers', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: 'pending',
      links: { body: NO_LINKS },
    });
    renderThread();
    await settle();
    expect(queryClient.getQueryState(chatKeys.conversation('conv-1'))?.status).toBe('success');

    await elapse(HOLD_CAP_MS - 1);
    expect(listShown()).toBe(false);

    await elapse(1);
    expect(listShown()).toBe(true);
  });

  it('mounts the list two seconds after the thread is ready when its links read never answers', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 2) },
      members: { body: LINK_GROUP },
      links: 'pending',
    });
    renderThread();
    await settle();
    expect(queryClient.getQueryState(memberKeys.list('conv-1'))?.status).toBe('success');

    await elapse(HOLD_CAP_MS - 1);
    expect(listShown()).toBe(false);

    await elapse(1);
    expect(listShown()).toBe(true);
  });

  it('mounts the list two seconds after the thread is ready when its reads are paused offline', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: { body: ACCOUNT_GROUP },
      links: { body: NO_LINKS },
    });
    queryClient.setQueryData(chatKeys.conversation('conv-1'), detailOf('conv-1', 3));
    onlineManager.setOnline(false);
    renderThread();
    await settle();
    expect(queryClient.getQueryState(memberKeys.list('conv-1'))?.fetchStatus).toBe('paused');

    await elapse(HOLD_CAP_MS - 1);
    expect(listShown()).toBe(false);

    await elapse(1);
    expect(listShown()).toBe(true);
  });

  it('mounts the list at the answer of a members read that lands before two seconds', async () => {
    const members = heldGate();
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: { body: ACCOUNT_GROUP, gate: members.gate },
      links: { body: NO_LINKS },
    });
    renderThread();
    await settle();
    await elapse(HOLD_CAP_MS / 2);
    expect(listShown()).toBe(false);

    members.open();
    await settle();

    expect(listShown()).toBe(true);
  });

  it('counts the two seconds from when the conversation read lands, not from when the page opened', async () => {
    const conversation = heldGate();
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3), gate: conversation.gate },
      members: 'pending',
      links: { body: NO_LINKS },
    });
    renderThread();
    await settle();
    await elapse(HOLD_CAP_MS * 0.75);
    conversation.open();
    await settle();
    expect(queryClient.getQueryState(chatKeys.conversation('conv-1'))?.status).toBe('success');

    await elapse(HOLD_CAP_MS - 1);
    expect(listShown()).toBe(false);

    await elapse(1);
    expect(listShown()).toBe(true);
  });

  it('counts the two seconds from when the messages are ready, not from when the group is known', async () => {
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: 'pending',
      links: { body: NO_LINKS },
    });
    const { rerender } = render(<Thread conversationId="conv-1" stillDecrypting={true} />, {
      wrapper,
    });
    await settle();
    await elapse(HOLD_CAP_MS * 0.75);

    rerender(<Thread conversationId="conv-1" stillDecrypting={false} />);
    await settle();
    await elapse(HOLD_CAP_MS - 1);
    expect(listShown()).toBe(false);

    await elapse(1);
    expect(listShown()).toBe(true);
  });

  it('draws the senders on the open list once a members read the cap outlasted lands', async () => {
    const members = heldGate();
    answerAll('conv-1', {
      conversation: { body: detailOf('conv-1', 3) },
      members: { body: ACCOUNT_GROUP, gate: members.gate },
      links: { body: NO_LINKS },
    });
    renderThread();
    await settle();
    await elapse(HOLD_CAP_MS);
    expect(listShown()).toBe(true);
    expect(list.renders.at(-1)?.isGroupChat).toBeUndefined();

    members.open();
    await settle();

    expect(list.renders.at(-1)).toEqual({
      isGroupChat: true,
      senders: ['alice', 'mallory', 'bob'],
    });
    expect(list.mounts).toBe(1);
  });

  describe('when the reader switches groups while one is held', () => {
    const SWITCH_AT_MS = HOLD_CAP_MS * 0.75;

    /** Two groups whose members reads never answer, both details already cached. */
    function twoHeldGroups(): void {
      for (const conversationId of ['conv-1', 'conv-2']) {
        answerAll(conversationId, {
          conversation: { body: detailOf(conversationId, 3) },
          members: 'pending',
          links: { body: NO_LINKS },
        });
        queryClient.setQueryData(
          chatKeys.conversation(conversationId),
          detailOf(conversationId, 3)
        );
      }
    }

    function showThread(
      rerender: ReturnType<typeof render>['rerender'],
      conversationId: string
    ): void {
      rerender(<Thread conversationId={conversationId} />);
    }

    it('gives the group switched to its own two seconds from the switch', async () => {
      twoHeldGroups();
      const { rerender } = renderThread('conv-1');
      await settle();
      await elapse(SWITCH_AT_MS);
      expect(listShown()).toBe(false);

      showThread(rerender, 'conv-2');
      await settle();
      await elapse(HOLD_CAP_MS - 1);
      expect(listShown()).toBe(false);

      await elapse(1);
      expect(listShown()).toBe(true);
    });

    it('does not let the wait begun before a switch open a group returned to', async () => {
      twoHeldGroups();
      const { rerender } = renderThread('conv-1');
      await settle();
      await elapse(SWITCH_AT_MS);
      showThread(rerender, 'conv-2');
      await settle();
      await elapse(HOLD_CAP_MS / 8);

      showThread(rerender, 'conv-1');
      await settle();
      await elapse(HOLD_CAP_MS / 4);
      expect(listShown()).toBe(false);
      await elapse(HOLD_CAP_MS * 0.75 - 1);
      expect(listShown()).toBe(false);

      await elapse(1);
      expect(listShown()).toBe(true);
    });

    it('leaves no wait running once a held thread is unmounted', async () => {
      twoHeldGroups();
      const { unmount } = renderThread('conv-1');
      await settle();
      await elapse(SWITCH_AT_MS);

      unmount();
      await queryClient.cancelQueries();
      queryClient.clear();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
