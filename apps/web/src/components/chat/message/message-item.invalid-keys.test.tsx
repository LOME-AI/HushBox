import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ERROR_CODES, friendlyErrorMessage, TEST_IDS } from '@hushbox/shared';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MessageItem } from '@/components/chat/message/message-item';
import { BadEpochsContext } from '@/components/chat/message/bad-epochs-context';
import { renderWithProviders } from '@/test-utils/render';
import type { Message } from '@/lib/api/api';
import type { MessageAction } from '@/lib/chat/message-actions';
import type { MessageGroup } from '@/lib/chat/sender';

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: { models: [] } }),
}));

// Reached through React.lazy; left real it scrambles that module's own coverage
// report, and this suite asserts only which bubble renders.
vi.mock('@/components/chat/message/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const ALL_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate', 'fork', 'share']);
const ALL_USER_ACTIONS = new Set<MessageAction>(['copy', 'retry', 'edit', 'fork', 'share']);

function messageAtEpoch(epochNumber?: number): Message {
  return {
    id: 'msg-epoch',
    conversationId: 'conv-1',
    role: 'assistant',
    content: '[decryption failed: missing epoch key]',
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
    wrappedContentKey: 'base64-wrapped-key',
    ...(epochNumber !== undefined && { epochNumber }),
  };
}

function renderInConversation(message: Message, badEpochs: ReadonlySet<number>): void {
  renderWithProviders(
    <BadEpochsContext value={badEpochs}>
      <MessageItem message={message} allowedActions={ALL_AI_ACTIONS} />
    </BadEpochsContext>
  );
}

describe('MessageItem written under invalid keys', () => {
  it('shows the invalid-keys placeholder for a message in a bad epoch', () => {
    renderInConversation(messageAtEpoch(3), new Set([3]));

    expect(screen.getByTestId(TEST_IDS.messageInvalidKeys)).toBeInTheDocument();
    expect(screen.queryByText('[decryption failed: missing epoch key]')).not.toBeInTheDocument();
  });

  it('offers no message actions on a message in a bad epoch', () => {
    renderInConversation(messageAtEpoch(3), new Set([3]));

    expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
  });

  it('renders a message in a verified epoch as usual', () => {
    renderInConversation(messageAtEpoch(2), new Set([3]));

    expect(screen.queryByTestId(TEST_IDS.messageInvalidKeys)).not.toBeInTheDocument();
    expect(screen.getByText('[decryption failed: missing epoch key]')).toBeInTheDocument();
  });

  it('renders a message with no epoch as usual', () => {
    renderInConversation(messageAtEpoch(), new Set([3]));

    expect(screen.queryByTestId(TEST_IDS.messageInvalidKeys)).not.toBeInTheDocument();
  });

  it('renders as usual outside a conversation that judged its keys', () => {
    renderWithProviders(
      <MessageItem message={messageAtEpoch(3)} allowedActions={ALL_AI_ACTIONS} />
    );

    expect(screen.queryByTestId(TEST_IDS.messageInvalidKeys)).not.toBeInTheDocument();
  });
});

function userMessage(id: string, content: string, epochNumber: number): Message {
  return {
    id,
    conversationId: 'conv-1',
    role: 'user',
    senderId: 'user-2',
    content,
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
    wrappedContentKey: 'base64-wrapped-key',
    epochNumber,
  };
}

function renderGroupInConversation(messages: Message[], badEpochs: ReadonlySet<number>): void {
  const [first] = messages;
  if (first === undefined) throw new Error('a group holds at least one message');
  const group: MessageGroup = { id: first.id, role: 'user', senderId: 'user-2', messages };
  renderWithProviders(
    <BadEpochsContext value={badEpochs}>
      <MessageItem
        message={first}
        group={group}
        isGroupChat
        currentUserId="user-1"
        members={[{ id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'write' }]}
        allowedActions={ALL_USER_ACTIONS}
      />
    </BadEpochsContext>
  );
}

describe('MessageItem grouped bubble written partly under invalid keys', () => {
  const readable = userMessage('msg-readable', 'Readable words', 2);
  const unreadable = userMessage('msg-unreadable', '[decryption failed: missing epoch key]', 3);

  it('shows the placeholder for a later message in a bad epoch', () => {
    renderGroupInConversation([readable, unreadable], new Set([3]));

    expect(screen.getByText('Readable words')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.messageInvalidKeys)).toBeInTheDocument();
    expect(screen.queryByText('[decryption failed: missing epoch key]')).not.toBeInTheDocument();
  });

  it('offers no message actions when a later message is in a bad epoch', () => {
    renderGroupInConversation([readable, unreadable], new Set([3]));

    expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
  });

  it('keeps later readable messages visible when the first is in a bad epoch', () => {
    renderGroupInConversation([unreadable, readable], new Set([3]));

    expect(screen.getByTestId(TEST_IDS.messageInvalidKeys)).toBeInTheDocument();
    expect(screen.getByText('Readable words')).toBeInTheDocument();
  });

  it('offers no message actions when the first message is in a bad epoch', () => {
    renderGroupInConversation([unreadable, readable], new Set([3]));

    expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
  });

  it('offers message actions when every grouped message is readable', () => {
    renderGroupInConversation([readable, userMessage('msg-second', 'More words', 2)], new Set([3]));

    expect(screen.getByTestId(TEST_IDS.messageActions)).toBeInTheDocument();
  });

  it('shows no media error for a first message in a bad epoch', () => {
    const withMedia: Message = {
      ...unreadable,
      mediaItems: [
        {
          id: 'ci-image-1',
          contentType: 'image',
          position: 0,
          mimeType: 'image/png',
          sizeBytes: 1_000_000,
          width: 1024,
          height: 1024,
        },
      ],
    };
    renderGroupInConversation([withMedia, readable], new Set([3]));

    expect(
      screen.queryByRole('status', { name: friendlyErrorMessage(ERROR_CODES.STORAGE_READ_FAILED) })
    ).not.toBeInTheDocument();
  });

  it('shows the media error for a first message whose key is merely missing', () => {
    const withMedia: Message = {
      ...readable,
      mediaItems: [
        {
          id: 'ci-image-1',
          contentType: 'image',
          position: 0,
          mimeType: 'image/png',
          sizeBytes: 1_000_000,
          width: 1024,
          height: 1024,
        },
      ],
    };
    renderGroupInConversation([withMedia, unreadable], new Set([3]));

    expect(
      screen.getByRole('status', { name: friendlyErrorMessage(ERROR_CODES.STORAGE_READ_FAILED) })
    ).toBeInTheDocument();
  });
});
