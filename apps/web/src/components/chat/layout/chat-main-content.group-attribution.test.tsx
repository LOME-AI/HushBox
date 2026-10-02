import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { ChatMainContent } from '@/components/chat/layout/chat-main-content';
import { useGroupChat } from '@/hooks/realtime/use-group-chat';
import { getCurrentEpoch } from '@/lib/crypto/epoch-key-cache';
import { renderWithProviders } from '@/test-utils/render';
import type { useConversationMembers } from '@/hooks/realtime/use-conversation-members';
import type { useConversationLinks } from '@/hooks/realtime/use-conversation-links';
import type { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import type { MessageListHandle } from '@/components/chat/message/message-list';
import type { Message } from '@/lib/api/api';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';

const MEMBERS = [
  { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
  { id: 'm2', userId: 'u2', username: 'mallory', privilege: 'write' },
];

// The members read reaches the hook as a query result; only its `data` is read,
// so the fixture is the envelope's `data` alone.
vi.mock(import('@/hooks/realtime/use-conversation-members'), async (importOriginal) => ({
  ...(await importOriginal()),
  useConversationMembers: () =>
    // Cast: a partial UseQueryResult; the hook reads only `data` and `error`.
    ({ data: { members: MEMBERS }, error: null }) as ReturnType<typeof useConversationMembers>,
}));

vi.mock(import('@/hooks/realtime/use-conversation-links'), async (importOriginal) => ({
  ...(await importOriginal()),
  useConversationLinks: () =>
    // Cast: a partial UseQueryResult; the hook reads only `data`.
    ({ data: { links: [] } }) as unknown as ReturnType<typeof useConversationLinks>,
}));

// A group of two opens the realtime socket; no socket server exists here.
vi.mock(import('@/hooks/realtime/use-conversation-websocket'), () => ({
  useConversationWebSocket: () => null,
}));

vi.mock(import('@tanstack/react-router'), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));

// MessageList reads the send gate once per list; its budget queries are not
// what this suite is about.
vi.mock(import('@/hooks/billing/use-prompt-budget'), async (importOriginal) => ({
  ...(await importOriginal()),
  usePromptBudget: () =>
    // Cast: MessageList reads only `sendRefusal`.
    ({ sendRefusal: undefined }) as ReturnType<typeof usePromptBudget>,
}));

const { MODELS_STUB } = vi.hoisted(() => {
  const stub: UseModelsStub = { data: { models: [], premiumIds: new Set<string>() } };
  return { MODELS_STUB: stub };
});
vi.mock(import('@/hooks/models/models'), async (importOriginal) => ({
  ...(await importOriginal()),
  // Cast: MessageList reads only `data` from the models query.
  useModels: () => MODELS_STUB as ReturnType<(typeof import('@/hooks/models/models'))['useModels']>,
}));

// A virtualized list measures nothing in a DOM without layout; the stand-in
// renders every row it is handed.
vi.mock(import('react-virtuoso'), async (importOriginal) => ({
  ...(await importOriginal()),
  Virtuoso: React.forwardRef(function RenderAllRows(
    props: {
      data?: readonly unknown[];
      itemContent?: (index: number, item: unknown) => React.ReactNode;
    },
    _ref: React.Ref<unknown>
  ) {
    return (
      <div>
        {(props.data ?? []).map((item, index) => (
          <div key={index}>{props.itemContent?.(index, item)}</div>
        ))}
      </div>
    );
    // Cast: the stand-in takes only the two props MessageList's rows depend on,
    // where the real component's generic signature spans every list option.
  }) as unknown as (typeof import('react-virtuoso'))['Virtuoso'],
}));

const MESSAGES: Message[] = [
  {
    id: 'msg-own',
    conversationId: 'conv-1',
    role: 'user',
    content: 'From the viewer',
    createdAt: isoAt(TEST_DAY_START),
    senderId: 'u1',
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

const NO_STREAMING = new Set<string>();

function GroupConversation(): React.JSX.Element {
  const groupChat = useGroupChat('conv-1', 'u1');
  const virtuosoRef = React.useRef<MessageListHandle>(null);
  return (
    <ChatMainContent
      messages={MESSAGES}
      streamingMessageIds={NO_STREAMING}
      persistingMessageIds={undefined}
      errorMessageId={undefined}
      modelName="gpt-4o"
      onShare={() => {}}
      onRegenerate={undefined}
      onEdit={undefined}
      onFork={undefined}
      isDecrypting={false}
      groupChat={groupChat}
      virtuosoRef={virtuosoRef}
      isAuthenticated={true}
      isLinkGuest={false}
      callerPrivilege="owner"
      conversationId="conv-1"
      activeForkId={null}
      messagesReady={true}
    />
  );
}

function messageItemOf(content: string): HTMLElement {
  const item = screen
    .getByText(content)
    .closest<HTMLElement>(`[data-testid="${TEST_IDS.messageItem}"]`);
  if (item === null) throw new Error(`no message item holds "${content}"`);
  return item;
}

describe('a group conversation with no verified current-epoch key', () => {
  it('starts from a key cache that knows nothing of the conversation', () => {
    expect(getCurrentEpoch('conv-1')).toBeUndefined();
  });

  it("renders another member's message on the other-member side", () => {
    renderWithProviders(<GroupConversation />);

    expect(messageItemOf('From another member')).toHaveClass('mr-auto');
  });

  it("names the sender of another member's message", () => {
    renderWithProviders(<GroupConversation />);

    expect(screen.getAllByTestId(TEST_IDS.senderLabel).map((label) => label.textContent)).toContain(
      'mallory'
    );
  });

  it("keeps the viewer's own message on the viewer's side", () => {
    renderWithProviders(<GroupConversation />);

    expect(messageItemOf('From the viewer')).toHaveClass('ml-auto');
  });
});
