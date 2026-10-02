import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, within } from '@testing-library/react';
import { noticeText, TEST_IDS } from '@hushbox/shared';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MessageControls } from '@/components/chat/message/message-controls';
import { buildChatContext, resolveMessageActions } from '@/lib/chat/message-actions';
import { renderWithProviders } from '@/test-utils/render';
import type { MessageHandlers } from '@/components/chat/message/message-controls';
import type { ChatContext, MessageAction } from '@/lib/chat/message-actions';
import type { Message } from '@/lib/api/api';

const ME = 'user-me';
const OTHER = 'user-other';

const ownMessage: Message = {
  id: 'm-user',
  conversationId: 'conv-1',
  role: 'user',
  content: 'Merge the two exports',
  senderId: ME,
  createdAt: isoAt(TEST_DAY_START),
};

const othersMessage: Message = { ...ownMessage, id: 'm-other', senderId: OTHER };

const reply: Message = {
  id: 'm-reply',
  conversationId: 'conv-1',
  role: 'assistant',
  content: 'Normalise the email first.',
  createdAt: isoAt(TEST_DAY_START + SECOND_MS),
};

function everyHandler(): Required<Omit<MessageHandlers, 'copyText'>> & MessageHandlers {
  return {
    onRegenerate: vi.fn(),
    onEdit: vi.fn(),
    onFork: vi.fn(),
    onShare: vi.fn(),
    copyText: () => 'copied words',
  };
}

function controlNames(): string[] {
  const group = screen.queryByTestId(TEST_IDS.messageActions);
  if (group === null) return [];
  return within(group)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? '');
}

function renderControls(
  message: Message,
  allowed: ReadonlySet<MessageAction>,
  handlers: MessageHandlers = everyHandler()
): void {
  renderWithProviders(<MessageControls message={message} allowed={allowed} handlers={handlers} />);
}

function allowedFor(chat: ChatContext, message: Message): ReadonlySet<MessageAction> {
  return resolveMessageActions(chat, {
    message,
    isStreaming: false,
    isError: false,
    isMultiModel: false,
    canRegenerate: true,
  });
}

describe('MessageControls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // The copy confirmation resets on a timer, which is a state update.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it('offers Retry, Edit, Copy on a user message, in that order', () => {
    renderControls(ownMessage, new Set<MessageAction>(['copy', 'retry', 'edit']));
    expect(controlNames()).toEqual(['Retry', 'Edit', 'Copy']);
  });

  it('never offers Fork on a user message, even when the set allows it', () => {
    renderControls(ownMessage, new Set<MessageAction>(['copy', 'retry', 'edit', 'fork']));
    expect(controlNames()).not.toContain('Fork');
  });

  it('offers Regenerate, Fork, Share, Copy on a reply, in that order', () => {
    renderControls(reply, new Set<MessageAction>(['copy', 'regenerate', 'fork', 'share']));
    expect(controlNames()).toEqual(['Regenerate', 'Fork', 'Share', 'Copy']);
  });

  it('renders nothing when no action is allowed, as while a reply streams', () => {
    renderControls(reply, new Set<MessageAction>());
    expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
  });

  it('names its group for assistive technology', () => {
    renderControls(reply, new Set<MessageAction>(['copy']));
    expect(screen.getByRole('group', { name: 'Message actions' })).toHaveAttribute(
      'data-testid',
      TEST_IDS.messageActions
    );
  });

  it('omits an allowed action whose handler the host does not supply', () => {
    renderControls(reply, new Set<MessageAction>(['copy', 'regenerate', 'share']), {
      copyText: () => '',
    });
    expect(controlNames()).toEqual(['Copy']);
  });

  it('copies the text the host supplies', async () => {
    renderControls(reply, new Set<MessageAction>(['copy']));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await Promise.resolve();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copied words');
  });

  it('confirms a copy on the button itself', async () => {
    renderControls(reply, new Set<MessageAction>(['copy']));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('passes the message id to each handler', () => {
    const handlers = everyHandler();
    renderControls(reply, new Set<MessageAction>(['regenerate', 'fork', 'share']), handlers);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(handlers.onRegenerate).toHaveBeenCalledWith('m-reply');
    expect(handlers.onFork).toHaveBeenCalledWith('m-reply');
    expect(handlers.onShare).toHaveBeenCalledWith('m-reply');
  });

  it('passes the message id and its text to Edit', () => {
    const handlers = everyHandler();
    renderControls(ownMessage, new Set<MessageAction>(['edit']), handlers);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(handlers.onEdit).toHaveBeenCalledWith('m-user', 'Merge the two exports');
  });

  it('retries a user message through the regenerate handler', () => {
    const handlers = everyHandler();
    renderControls(ownMessage, new Set<MessageAction>(['retry']), handlers);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(handlers.onRegenerate).toHaveBeenCalledWith('m-user');
  });

  describe('a refused re-run', () => {
    function renderRefused(message: Message, action: MessageAction): MessageHandlers {
      const handlers = everyHandler();
      renderWithProviders(
        <MessageControls
          message={message}
          allowed={new Set<MessageAction>([action])}
          handlers={handlers}
          regenerateRefusal="insufficient_funds"
        />
      );
      return handlers;
    }

    it('keeps Regenerate focusable but unavailable', () => {
      renderRefused(reply, 'regenerate');
      expect(screen.getByRole('button', { name: 'Regenerate' })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    });

    it('describes why Regenerate is unavailable', () => {
      renderRefused(reply, 'regenerate');
      expect(screen.getByRole('button', { name: 'Regenerate' })).toHaveAccessibleDescription(
        noticeText('insufficient_funds')
      );
    });

    it('does not run a refused Regenerate', () => {
      const handlers = renderRefused(reply, 'regenerate');
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
      expect(handlers.onRegenerate).not.toHaveBeenCalled();
    });

    it('does not run a refused Retry', () => {
      const handlers = renderRefused(ownMessage, 'retry');
      const retry = screen.getByRole('button', { name: 'Retry' });
      fireEvent.click(retry);
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      expect(handlers.onRegenerate).not.toHaveBeenCalled();
    });
  });

  describe('the control set in each chat mode', () => {
    const solo = buildChatContext({
      isAuthenticated: true,
      isLinkGuest: false,
      privilege: undefined,
      currentUserId: ME,
      isGroupChat: false,
    });
    const groupMember = buildChatContext({
      isAuthenticated: true,
      isLinkGuest: false,
      privilege: 'write',
      currentUserId: ME,
      isGroupChat: true,
    });
    const groupReader = buildChatContext({
      isAuthenticated: true,
      isLinkGuest: false,
      privilege: 'read',
      currentUserId: ME,
      isGroupChat: true,
    });
    const linkGuestWriter = buildChatContext({
      isAuthenticated: false,
      isLinkGuest: true,
      privilege: 'write',
      currentUserId: ME,
      isGroupChat: true,
    });
    const linkGuestReader = buildChatContext({
      isAuthenticated: false,
      isLinkGuest: true,
      privilege: 'read',
      currentUserId: ME,
      isGroupChat: true,
    });
    const trial = buildChatContext({
      isAuthenticated: false,
      isLinkGuest: false,
      privilege: undefined,
      currentUserId: undefined,
      isGroupChat: false,
    });

    it.each([
      ['solo, own message', solo, ownMessage, ['Retry', 'Edit', 'Copy']],
      ['solo, reply', solo, reply, ['Regenerate', 'Fork', 'Share', 'Copy']],
      ['group member, own message', groupMember, ownMessage, ['Retry', 'Edit', 'Copy']],
      ["group member, another member's message", groupMember, othersMessage, ['Copy']],
      ['group member, reply', groupMember, reply, ['Regenerate', 'Fork', 'Share', 'Copy']],
      ['read-only member, own message', groupReader, ownMessage, ['Copy']],
      ['read-only member, reply', groupReader, reply, ['Copy']],
      [
        'link guest with write, own message',
        linkGuestWriter,
        ownMessage,
        ['Retry', 'Edit', 'Copy'],
      ],
      ['link guest with write, reply', linkGuestWriter, reply, ['Regenerate', 'Fork', 'Copy']],
      ['link guest read-only, reply', linkGuestReader, reply, ['Copy']],
      ['trial, own message', trial, ownMessage, ['Retry', 'Edit', 'Copy']],
      ['trial, reply', trial, reply, ['Regenerate', 'Copy']],
    ] as const)('%s', (_name, chat, message, expected) => {
      renderControls(message, allowedFor(chat, message));
      expect(controlNames()).toEqual(expected);
    });
  });
});
