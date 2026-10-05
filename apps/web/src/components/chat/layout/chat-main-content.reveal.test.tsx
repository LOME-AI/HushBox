import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { ChatMainContent } from '@/components/chat/layout/chat-main-content';
import type { Message } from '@/lib/api/api';
import type { MessageListHandle } from '@/components/chat/message/message-list';

// The list stands in for itself here: what this file pins is the host's side of the reveal, the
// placeholder it keeps over the thread until the list says the thread is drawn where it rests.
const { reveal } = vi.hoisted(() => ({
  reveal: { current: undefined as ((revealed: boolean) => void) | undefined },
}));
vi.mock('@/components/chat/message/message-list', () => ({
  MessageList: function MessageListStub({
    onRevealedChange,
  }: Readonly<{ onRevealedChange?: (revealed: boolean) => void }>): React.JSX.Element {
    reveal.current = onRevealedChange;
    return <div data-testid="message-list-stub" />;
  },
}));

// Whether a group's senders can be named yet is pinned beside the host's own hold; this file
// is about the reveal, so no conversation here waits on it.
vi.mock('@/hooks/chat/use-sender-identity-pending', () => ({
  useSenderIdentityPending: (): boolean => false,
}));

const MESSAGES: Message[] = [
  {
    id: '1',
    conversationId: 'c1',
    role: 'user',
    content: 'Hello!',
    createdAt: isoAt(TEST_DAY_START),
  },
  {
    id: '2',
    conversationId: 'c1',
    role: 'assistant',
    content: 'Hi there!',
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
  },
];

const NO_STREAMS = new Set<string>();

function Content({
  messages,
  isDecrypting,
}: Readonly<{ messages: Message[]; isDecrypting: boolean }>): React.JSX.Element {
  return (
    <ChatMainContent
      messages={messages}
      streamingMessageIds={NO_STREAMS}
      persistingMessageIds={undefined}
      errorMessageId={undefined}
      modelName="gpt-4o"
      onShare={vi.fn<(messageId: string) => void>()}
      onRegenerate={undefined}
      onEdit={undefined}
      onFork={undefined}
      isDecrypting={isDecrypting}
      groupChat={undefined}
      virtuosoRef={React.createRef<MessageListHandle>()}
      isAuthenticated={true}
      isLinkGuest={false}
      callerPrivilege={undefined}
      conversationId="c1"
      activeForkId={null}
      messagesReady={!isDecrypting}
      threadHeader={undefined}
      threadFooter={undefined}
    />
  );
}

function placeholder(): HTMLElement | null {
  return screen.queryByTestId(TEST_IDS.sharedConversationLoading);
}

describe('the thread area while the thread is not yet drawn', () => {
  beforeEach(() => {
    reveal.current = undefined;
  });

  it('shows the decrypting placeholder while the conversation decrypts', () => {
    render(<Content messages={[]} isDecrypting={true} />);
    expect(placeholder()).toBeInTheDocument();
  });

  it('keeps the placeholder once the messages arrive and the list has not revealed the thread', () => {
    render(<Content messages={MESSAGES} isDecrypting={false} />);
    expect(placeholder()).toBeInTheDocument();
  });

  it('mounts the list under the placeholder so it can place the thread', () => {
    render(<Content messages={MESSAGES} isDecrypting={false} />);
    expect(screen.getByTestId('message-list-stub')).toBeInTheDocument();
  });

  it('removes the placeholder once the list reveals the thread', () => {
    render(<Content messages={MESSAGES} isDecrypting={false} />);
    act(() => {
      reveal.current?.(true);
    });
    expect(placeholder()).not.toBeInTheDocument();
  });

  it('shows the placeholder again when the list hides the thread to open it anew', () => {
    render(<Content messages={MESSAGES} isDecrypting={false} />);
    act(() => {
      reveal.current?.(true);
    });
    act(() => {
      reveal.current?.(false);
    });
    expect(placeholder()).toBeInTheDocument();
  });

  it('shows no placeholder over an empty conversation', () => {
    render(<Content messages={[]} isDecrypting={false} />);
    expect(placeholder()).not.toBeInTheDocument();
  });
});
