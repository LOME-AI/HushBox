import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatLayout } from './chat-layout';
import type { GroupChatProps } from './chat-layout';
import type { Message } from '@/lib/api';

import type { ConversationWebSocket } from '@/lib/ws-client';

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => 800,
}));

vi.mock('@/hooks/use-keyboard-offset', () => ({
  useKeyboardOffset: () => ({ bottom: 0, isKeyboardVisible: false }),
}));

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/hooks/use-scroll-behavior', () => ({
  useScrollBehavior: () => ({
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    bottomPadding: 800,
    isAutoScrollEnabled: true,
  }),
}));

vi.mock('@/hooks/use-premium-model-click', () => ({
  usePremiumModelClick: () => vi.fn(),
}));

vi.mock('@/hooks/use-tier-info', () => ({
  useTierInfo: () => ({ canAccessPremium: true }),
}));

vi.mock('@/hooks/models', () => ({
  useModels: () => ({
    data: { models: [], premiumIds: new Set() },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = () => ({
    selectedModels: [{ id: 'gpt-4', name: 'GPT-4' }],
  });
  store.setState = vi.fn();
  return { ...actual, useModelStore: store };
});

vi.mock('@/stores/search', () => ({
  useSearchStore: () => ({
    webSearchEnabled: false,
    toggleWebSearch: vi.fn(),
  }),
}));

vi.mock('@/stores/ui-modals', () => ({
  useUIModalsStore: () => ({
    signupModalOpen: false,
    paymentModalOpen: false,
    premiumModelName: undefined,
    setSignupModalOpen: vi.fn(),
    setPaymentModalOpen: vi.fn(),
    memberSidebarOpen: false,
    mobileMemberSidebarOpen: false,
    addMemberModalOpen: false,
    budgetSettingsModalOpen: false,
    inviteLinkModalOpen: false,
    shareMessageModalOpen: false,
    shareMessageId: null,
    setMemberSidebarOpen: vi.fn(),
    setMobileMemberSidebarOpen: vi.fn(),
    openMemberSidebar: vi.fn(),
    toggleMemberSidebar: vi.fn(),
    closeMemberSidebar: vi.fn(),
    closeAddMemberModal: vi.fn(),
    openAddMemberModal: vi.fn(),
    closeBudgetSettingsModal: vi.fn(),
    openBudgetSettingsModal: vi.fn(),
    closeInviteLinkModal: vi.fn(),
    openInviteLinkModal: vi.fn(),
    openShareMessageModal: vi.fn(),
    closeShareMessageModal: vi.fn(),
  }),
}));

vi.mock('@/components/chat/chat-header', () => ({
  ChatHeader: ({ title, members }: { title?: string; members?: unknown[] }) => (
    <div data-testid="chat-header" data-member-count={members?.length ?? 0}>
      {title}
    </div>
  ),
}));

vi.mock('@/components/chat/message-list', () => ({
  MessageList: ({
    messages,
    onShare,
    onRegenerate,
    onEdit,
    onFork,
    canRegenerate,
    isGroupChat,
    currentUserId,
    members,
  }: {
    messages: Message[];
    onShare?: (id: string) => void;
    onRegenerate?: (id: string) => void;
    onEdit?: (id: string, content: string) => void;
    onFork?: (id: string) => void;
    canRegenerate?: boolean;
    isGroupChat?: boolean;
    currentUserId?: string;
    members?: { id: string; userId: string; username: string; privilege: string }[];
  }) => (
    <div
      data-testid="message-list"
      data-has-on-share={onShare ? 'true' : 'false'}
      data-has-on-regenerate={onRegenerate ? 'true' : 'false'}
      data-has-on-edit={onEdit ? 'true' : 'false'}
      data-has-on-fork={onFork ? 'true' : 'false'}
      {...(canRegenerate === undefined ? {} : { 'data-can-regenerate': String(canRegenerate) })}
      {...(isGroupChat ? { 'data-is-group-chat': 'true' } : {})}
      {...(currentUserId === undefined ? {} : { 'data-current-user-id': currentUserId })}
      {...(members === undefined ? {} : { 'data-member-count-list': String(members.length) })}
    >
      {messages.length} messages
    </div>
  ),
}));

let capturedOnTypingChange: ((isTyping: boolean) => void) | undefined;

vi.mock('@/components/chat/prompt-input', () => ({
  PromptInput: React.forwardRef(function MockPromptInput(
    {
      value,
      onChange,
      onSubmit,
      disabled,
      autoFocus,
      onTypingChange,
      webSearchEnabled,
      modelSupportsSearch,
      isAuthenticated,
      onToggleWebSearch,
      conversationId,
      currentUserPrivilege,
    }: {
      value: string;
      onChange: (v: string) => void;
      onSubmit: () => void;
      disabled: boolean;
      autoFocus?: boolean;
      onTypingChange?: (isTyping: boolean) => void;
      webSearchEnabled?: boolean;
      modelSupportsSearch?: boolean;
      isAuthenticated?: boolean;
      onToggleWebSearch?: () => void;
      conversationId?: string | null;
      currentUserPrivilege?: string;
    },
    ref: React.ForwardedRef<{ focus: () => void }>
  ) {
    // eslint-disable-next-line react-hooks/globals -- test mock captures prop for later assertion
    capturedOnTypingChange = onTypingChange;
    React.useImperativeHandle(ref, () => ({ focus: vi.fn() }), []);
    return (
      <input
        data-testid="prompt-input"
        data-autofocus={autoFocus ? 'true' : 'false'}
        data-has-typing-change={onTypingChange ? 'true' : 'false'}
        {...(webSearchEnabled !== undefined && {
          'data-web-search-enabled': String(webSearchEnabled),
        })}
        {...(modelSupportsSearch !== undefined && {
          'data-model-supports-search': String(modelSupportsSearch),
        })}
        {...(isAuthenticated !== undefined && {
          'data-is-authenticated': String(isAuthenticated),
        })}
        {...(onToggleWebSearch !== undefined && {
          'data-has-toggle-web-search': 'true',
        })}
        {...(conversationId !== undefined && {
          'data-conversation-id': String(conversationId),
        })}
        {...(currentUserPrivilege !== undefined && {
          'data-current-user-privilege': currentUserPrivilege,
        })}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
        disabled={disabled}
      />
    );
  }),
}));

vi.mock('@/components/document-panel/document-panel', () => ({
  DocumentPanel: () => <div data-testid="document-panel" />,
}));

vi.mock('@/components/auth/signup-modal', () => ({
  SignupModal: () => <div data-testid="signup-modal" />,
}));

vi.mock('@/components/billing/payment-modal', () => ({
  PaymentModal: () => <div data-testid="payment-modal" />,
}));

vi.mock('@/components/chat/member-sidebar', () => ({
  MemberSidebar: () => <div data-testid="member-sidebar" />,
}));

vi.mock('@/components/chat/add-member-modal', () => ({
  AddMemberModal: (props: Record<string, unknown>) => (
    <div data-testid="add-member-modal" data-member-count={props['memberCount']} />
  ),
}));

vi.mock('@/components/chat/budget-settings-modal', () => ({
  BudgetSettingsModal: () => <div data-testid="budget-settings-modal" />,
}));

vi.mock('@/components/chat/invite-link-modal', () => ({
  InviteLinkModal: (props: Record<string, unknown>) => (
    <div data-testid="invite-link-modal" data-member-count={props['memberCount']} />
  ),
}));

vi.mock('@/components/chat/share-message-modal', () => ({
  ShareMessageModal: () => <div data-testid="share-message-modal" />,
}));

vi.mock('@/components/chat/fork-tabs', () => ({
  ForkTabs: ({
    forks,
    activeForkId,
    onForkSelect,
    onRename,
    onDelete,
  }: {
    forks: { id: string; name: string }[];
    activeForkId: string | null;
    onForkSelect: (id: string) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
  }) => (
    <div
      data-testid="fork-tabs"
      data-fork-count={forks.length}
      data-active-fork-id={activeForkId ?? ''}
      data-has-on-fork-select={String(Boolean(onForkSelect))}
      data-has-on-rename={String(Boolean(onRename))}
      data-has-on-delete={String(Boolean(onDelete))}
    >
      {forks.map((f: { id: string; name: string }) => (
        <span key={f.id}>{f.name}</span>
      ))}
    </div>
  ),
}));

vi.mock('@/components/chat/typing-indicator', () => ({
  TypingIndicator: ({
    typingUserIds,
    members,
  }: {
    typingUserIds: Set<string>;
    members: { userId: string; username: string }[];
  }) => (
    <div
      data-testid="typing-indicator"
      data-typing-count={typingUserIds.size}
      data-member-count={members.length}
    />
  ),
}));

describe('ChatLayout', () => {
  const defaultProps = {
    messages: [] as Message[],
    streamingMessageIds: new Set<string>(),
    inputValue: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    inputDisabled: false,
    isProcessing: false,
    historyCharacters: 0,
    isAuthenticated: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the chat header', () => {
    render(<ChatLayout {...defaultProps} title="Test Chat" />);

    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it('renders message list when messages exist', () => {
    const messages: Message[] = [
      {
        id: '1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hi',
        createdAt: '',
      },
    ];

    render(<ChatLayout {...defaultProps} messages={messages} />);

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByText('1 messages')).toBeInTheDocument();
  });

  it('renders message list even when no messages (empty state has role="log")', () => {
    render(<ChatLayout {...defaultProps} messages={[]} />);

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('shows decrypting indicator when isDecrypting and no messages', () => {
    render(<ChatLayout {...defaultProps} messages={[]} isDecrypting={true} />);

    expect(screen.getByTestId('shared-conversation-loading')).toBeInTheDocument();
    expect(screen.getByText('Decrypting your conversation...')).toBeInTheDocument();
    // Header and input should still be visible
    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-input')).toBeInTheDocument();
  });

  it('does not show decrypting indicator when messages exist', () => {
    const messages: Message[] = [
      { id: '1', conversationId: 'conv-1', role: 'user', content: 'Hi', createdAt: '' },
    ];

    render(<ChatLayout {...defaultProps} messages={messages} isDecrypting={true} />);

    expect(screen.queryByTestId('shared-conversation-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('renders document panel', () => {
    render(<ChatLayout {...defaultProps} />);

    expect(screen.getByTestId('document-panel')).toBeInTheDocument();
  });

  it('renders prompt input', () => {
    render(<ChatLayout {...defaultProps} inputValue="Hello" />);

    const input = screen.getByTestId('prompt-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('Hello');
  });

  it('calls onInputChange when typing', async () => {
    const onInputChange = vi.fn();
    const user = userEvent.setup();

    render(<ChatLayout {...defaultProps} onInputChange={onInputChange} />);

    await user.type(screen.getByTestId('prompt-input'), 'a');

    expect(onInputChange).toHaveBeenCalledWith('a');
  });

  it('calls onSubmit when pressing Enter', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(<ChatLayout {...defaultProps} onSubmit={onSubmit} />);

    await user.type(screen.getByTestId('prompt-input'), '{Enter}');

    expect(onSubmit).toHaveBeenCalled();
  });

  it('disables input when inputDisabled is true', () => {
    render(<ChatLayout {...defaultProps} inputDisabled={true} />);

    expect(screen.getByTestId('prompt-input')).toBeDisabled();
  });

  it('renders modals', () => {
    render(<ChatLayout {...defaultProps} />);

    expect(screen.getByTestId('signup-modal')).toBeInTheDocument();
    expect(screen.getByTestId('payment-modal')).toBeInTheDocument();
  });

  it('passes autoFocus=true to prompt input on desktop', () => {
    render(<ChatLayout {...defaultProps} />);

    expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-autofocus', 'true');
  });

  it('wraps prompt input in a centered max-width container', () => {
    render(<ChatLayout {...defaultProps} />);

    const input = screen.getByTestId('prompt-input');
    expect(input.parentElement).toHaveClass('mx-auto', 'w-full', 'max-w-3xl');
  });

  describe('group chat features', () => {
    const defaultGroupChat: GroupChatProps = {
      conversationId: 'conv-123',
      members: [
        { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
        { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
      ],
      links: [],
      onlineMemberIds: new Set<string>(),
      currentUserId: 'u1',
      currentUserPrivilege: 'owner',
      currentEpochPrivateKey: new Uint8Array(32),
      currentEpochNumber: 1,
    };

    it('renders group modals when groupChat is provided', () => {
      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={defaultGroupChat} />
      );

      expect(screen.getByTestId('add-member-modal')).toBeInTheDocument();
      expect(screen.getByTestId('budget-settings-modal')).toBeInTheDocument();
      expect(screen.getByTestId('invite-link-modal')).toBeInTheDocument();
    });

    it('renders member sidebar when groupChat is provided (visibility handled by SidebarPanel)', () => {
      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={defaultGroupChat} />
      );

      expect(screen.getByTestId('member-sidebar')).toBeInTheDocument();
    });

    it('renders member sidebar in loading state when conversationId provided without groupChat', () => {
      render(<ChatLayout {...defaultProps} conversationId="conv-123" />);

      expect(screen.getByTestId('member-sidebar')).toBeInTheDocument();
    });

    it('does not render member sidebar without conversationId', () => {
      render(<ChatLayout {...defaultProps} />);

      expect(screen.queryByTestId('member-sidebar')).not.toBeInTheDocument();
    });

    it('does not render member sidebar for unauthenticated users without conversationId', () => {
      render(<ChatLayout {...defaultProps} isAuthenticated={false} />);

      expect(screen.queryByTestId('member-sidebar')).not.toBeInTheDocument();
    });

    it('renders member sidebar for guest users with conversationId and groupChat', () => {
      render(
        <ChatLayout
          {...defaultProps}
          isAuthenticated={false}
          conversationId="conv-123"
          groupChat={defaultGroupChat}
        />
      );

      expect(screen.getByTestId('member-sidebar')).toBeInTheDocument();
    });

    it('does not render group modals without groupChat', () => {
      render(<ChatLayout {...defaultProps} />);

      expect(screen.queryByTestId('add-member-modal')).not.toBeInTheDocument();
      expect(screen.queryByTestId('budget-settings-modal')).not.toBeInTheDocument();
      expect(screen.queryByTestId('invite-link-modal')).not.toBeInTheDocument();
    });

    it('does not render group modals when conversationId provided without groupChat', () => {
      render(<ChatLayout {...defaultProps} conversationId="conv-123" />);

      expect(screen.queryByTestId('add-member-modal')).not.toBeInTheDocument();
      expect(screen.queryByTestId('budget-settings-modal')).not.toBeInTheDocument();
      expect(screen.queryByTestId('invite-link-modal')).not.toBeInTheDocument();
    });

    it('passes members to ChatHeader when groupChat provided', () => {
      render(<ChatLayout {...defaultProps} groupChat={defaultGroupChat} />);

      expect(screen.getByTestId('chat-header')).toHaveAttribute('data-member-count', '2');
    });

    it('passes memberCount to AddMemberModal and InviteLinkModal', () => {
      const groupChatWithLinks = {
        ...defaultGroupChat,
        links: [
          { id: 'l1', displayName: null, privilege: 'read', createdAt: '2025-01-01' },
          { id: 'l2', displayName: 'Guest', privilege: 'write', createdAt: '2025-01-02' },
        ],
      };
      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithLinks} />
      );

      // 2 members + 2 links = 4
      expect(screen.getByTestId('add-member-modal')).toHaveAttribute('data-member-count', '4');
      expect(screen.getByTestId('invite-link-modal')).toHaveAttribute('data-member-count', '4');
    });

    it('does not pass members to ChatHeader without groupChat', () => {
      render(<ChatLayout {...defaultProps} />);

      expect(screen.getByTestId('chat-header')).toHaveAttribute('data-member-count', '0');
    });

    it('passes group chat context to MessageList when members > 1', () => {
      const groupMessages: Message[] = [
        {
          id: 'm1',
          conversationId: 'conv-123',
          role: 'user',
          content: 'Hello',
          createdAt: '',
          senderId: 'u1',
        },
      ];

      render(
        <ChatLayout
          {...defaultProps}
          messages={groupMessages}
          conversationId="conv-123"
          groupChat={defaultGroupChat}
        />
      );

      const messageList = screen.getByTestId('message-list');
      expect(messageList).toHaveAttribute('data-is-group-chat', 'true');
      expect(messageList).toHaveAttribute('data-current-user-id', 'u1');
      expect(messageList).toHaveAttribute('data-member-count-list', '2');
    });

    it('does not pass group chat context to MessageList when only 1 member', () => {
      const singleMemberGroupChat = {
        ...defaultGroupChat,
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
      };
      const groupMessages: Message[] = [
        { id: 'm1', conversationId: 'conv-123', role: 'user', content: 'Solo', createdAt: '' },
      ];

      render(
        <ChatLayout
          {...defaultProps}
          messages={groupMessages}
          conversationId="conv-123"
          groupChat={singleMemberGroupChat}
        />
      );

      const messageList = screen.getByTestId('message-list');
      expect(messageList).not.toHaveAttribute('data-is-group-chat');
    });

    it('does not pass group chat context to MessageList without groupChat', () => {
      const msgs: Message[] = [
        { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'Hello', createdAt: '' },
      ];

      render(<ChatLayout {...defaultProps} messages={msgs} />);

      const messageList = screen.getByTestId('message-list');
      expect(messageList).not.toHaveAttribute('data-is-group-chat');
    });

    it('renders typing indicator when typingUserIds has entries', () => {
      const groupChatWithTyping = {
        ...defaultGroupChat,
        typingUserIds: new Set(['u2']),
      };

      render(
        <ChatLayout
          {...defaultProps}
          conversationId="conv-123"
          groupChat={groupChatWithTyping}
          messages={[
            {
              id: 'm1',
              conversationId: 'conv-123',
              role: 'user' as const,
              content: 'Hi',
              createdAt: '',
            },
          ]}
        />
      );

      expect(screen.getByTestId('typing-indicator')).toBeInTheDocument();
      expect(screen.getByTestId('typing-indicator')).toHaveAttribute('data-typing-count', '1');
    });

    it('does not render typing indicator when typingUserIds is empty', () => {
      const groupChatWithEmptyTyping = {
        ...defaultGroupChat,
        typingUserIds: new Set<string>(),
      };

      render(
        <ChatLayout
          {...defaultProps}
          conversationId="conv-123"
          groupChat={groupChatWithEmptyTyping}
          messages={[
            {
              id: 'm1',
              conversationId: 'conv-123',
              role: 'user' as const,
              content: 'Hi',
              createdAt: '',
            },
          ]}
        />
      );

      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
    });

    it('does not render typing indicator without groupChat', () => {
      render(
        <ChatLayout
          {...defaultProps}
          messages={[
            {
              id: 'm1',
              conversationId: 'conv-1',
              role: 'user' as const,
              content: 'Hi',
              createdAt: '',
            },
          ]}
        />
      );

      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
    });

    it('does not render typing indicator when typingUserIds is undefined', () => {
      render(
        <ChatLayout
          {...defaultProps}
          conversationId="conv-123"
          groupChat={defaultGroupChat}
          messages={[
            {
              id: 'm1',
              conversationId: 'conv-123',
              role: 'user' as const,
              content: 'Hi',
              createdAt: '',
            },
          ]}
        />
      );

      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
    });

    it('passes onTypingChange to PromptInput when groupChat has ws', () => {
      const mockWs = {
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as ConversationWebSocket;
      const groupChatWithWs = {
        ...defaultGroupChat,
        ws: mockWs,
      };

      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithWs} />
      );

      expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-has-typing-change', 'true');
    });

    it('does not pass onTypingChange without groupChat', () => {
      capturedOnTypingChange = undefined;

      render(<ChatLayout {...defaultProps} />);

      expect(screen.getByTestId('prompt-input')).toHaveAttribute('data-has-typing-change', 'false');
    });

    it('sends typing:start event when onTypingChange called with true', () => {
      const mockSend = vi.fn();
      const mockWs = {
        send: mockSend,
        on: vi.fn(),
        close: vi.fn(),
        connected: true,
      } as unknown as ConversationWebSocket;
      const groupChatWithWs = {
        ...defaultGroupChat,
        ws: mockWs,
      };

      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithWs} />
      );

      capturedOnTypingChange!(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'typing:start', conversationId: 'conv-123', userId: 'u1' })
      );
    });

    it('sends typing:stop event when onTypingChange called with false', () => {
      const mockSend = vi.fn();
      const mockWs = {
        send: mockSend,
        on: vi.fn(),
        close: vi.fn(),
        connected: true,
      } as unknown as ConversationWebSocket;
      const groupChatWithWs = {
        ...defaultGroupChat,
        ws: mockWs,
      };

      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithWs} />
      );

      capturedOnTypingChange!(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'typing:stop', conversationId: 'conv-123', userId: 'u1' })
      );
    });

    it('does not throw when onTypingChange called after ws disconnects', () => {
      const mockWs = {
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
        connected: false,
      } as unknown as ConversationWebSocket;
      const groupChatWithWs = {
        ...defaultGroupChat,
        ws: mockWs,
      };

      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithWs} />
      );

      expect(() => {
        capturedOnTypingChange!(false);
      }).not.toThrow();
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('renders data-ws-connected="true" when ws is connected', () => {
      const mockWs = {
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
        connected: true,
      } as unknown as ConversationWebSocket;
      const groupChatWithWs = {
        ...defaultGroupChat,
        ws: mockWs,
      };

      const { container } = render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithWs} />
      );

      expect(container.querySelector('[data-ws-connected="true"]')).toBeInTheDocument();
    });

    it('does not render data-ws-connected when ws is not connected', () => {
      const mockWs = {
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
        connected: false,
      } as unknown as ConversationWebSocket;
      const groupChatWithWs = {
        ...defaultGroupChat,
        ws: mockWs,
      };

      const { container } = render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithWs} />
      );

      expect(container.querySelector('[data-ws-connected]')).not.toBeInTheDocument();
    });

    it('does not render data-ws-connected without groupChat', () => {
      const { container } = render(
        <ChatLayout
          {...defaultProps}
          messages={[
            {
              id: 'm1',
              conversationId: 'conv-1',
              role: 'user' as const,
              content: 'Hi',
              createdAt: '',
            },
          ]}
        />
      );

      expect(container.querySelector('[data-ws-connected]')).not.toBeInTheDocument();
    });
  });

  describe('prompt input privilege and conversationId forwarding', () => {
    it('passes conversationId and currentUserPrivilege to PromptInput when groupChat is provided', () => {
      const groupChat: GroupChatProps = {
        conversationId: 'conv-123',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
      };

      render(<ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChat} />);

      const input = screen.getByTestId('prompt-input');
      expect(input).toHaveAttribute('data-conversation-id', 'conv-123');
      expect(input).toHaveAttribute('data-current-user-privilege', 'owner');
    });

    it('passes both conversationId and callerPrivilege to PromptInput when groupChat is undefined (link guest fallback)', () => {
      render(<ChatLayout {...defaultProps} conversationId="conv-456" callerPrivilege="read" />);

      const input = screen.getByTestId('prompt-input');
      expect(input).toHaveAttribute('data-conversation-id', 'conv-456');
      expect(input).toHaveAttribute('data-current-user-privilege', 'read');
    });

    it('does not pass conversationId or currentUserPrivilege for solo conversations', () => {
      render(<ChatLayout {...defaultProps} />);

      const input = screen.getByTestId('prompt-input');
      expect(input).not.toHaveAttribute('data-conversation-id');
      expect(input).not.toHaveAttribute('data-current-user-privilege');
    });
  });

  it('always renders share message modal', () => {
    render(<ChatLayout {...defaultProps} />);

    expect(screen.getByTestId('share-message-modal')).toBeInTheDocument();
  });

  it('passes onShare handler to MessageList', () => {
    const messages: Message[] = [
      { id: '1', conversationId: 'conv-1', role: 'assistant', content: 'Hi', createdAt: '' },
    ];

    render(<ChatLayout {...defaultProps} messages={messages} />);

    expect(screen.getByTestId('message-list')).toHaveAttribute('data-has-on-share', 'true');
  });

  describe('fork tabs', () => {
    const forks = [
      {
        id: 'fork-main',
        conversationId: 'conv-1',
        name: 'Main',
        tipMessageId: 'msg-5',
        createdAt: '2026-03-03',
      },
      {
        id: 'fork-1',
        conversationId: 'conv-1',
        name: 'Fork 1',
        tipMessageId: 'msg-3',
        createdAt: '2026-03-03',
      },
    ];

    it('renders ForkTabs when forks are provided', () => {
      render(
        <ChatLayout
          {...defaultProps}
          forks={forks}
          activeForkId="fork-main"
          onForkSelect={vi.fn()}
          onForkRename={vi.fn()}
          onForkDelete={vi.fn()}
        />
      );

      expect(screen.getByTestId('fork-tabs')).toBeInTheDocument();
      expect(screen.getByTestId('fork-tabs')).toHaveAttribute('data-fork-count', '2');
    });

    it('passes activeForkId to ForkTabs', () => {
      render(
        <ChatLayout
          {...defaultProps}
          forks={forks}
          activeForkId="fork-1"
          onForkSelect={vi.fn()}
          onForkRename={vi.fn()}
          onForkDelete={vi.fn()}
        />
      );

      expect(screen.getByTestId('fork-tabs')).toHaveAttribute('data-active-fork-id', 'fork-1');
    });

    it('passes callback props to ForkTabs', () => {
      render(
        <ChatLayout
          {...defaultProps}
          forks={forks}
          activeForkId="fork-main"
          onForkSelect={vi.fn()}
          onForkRename={vi.fn()}
          onForkDelete={vi.fn()}
        />
      );

      const tabs = screen.getByTestId('fork-tabs');
      expect(tabs).toHaveAttribute('data-has-on-fork-select', 'true');
      expect(tabs).toHaveAttribute('data-has-on-rename', 'true');
      expect(tabs).toHaveAttribute('data-has-on-delete', 'true');
    });

    it('renders ForkTabs with empty array when no forks provided', () => {
      render(<ChatLayout {...defaultProps} />);

      const tabs = screen.getByTestId('fork-tabs');
      expect(tabs).toHaveAttribute('data-fork-count', '0');
    });
  });

  describe('message action callbacks', () => {
    it('passes onRegenerate to MessageList when provided', () => {
      const messages: Message[] = [
        { id: '1', conversationId: 'conv-1', role: 'user', content: 'Hi', createdAt: '' },
      ];
      render(<ChatLayout {...defaultProps} messages={messages} onRegenerate={vi.fn()} />);

      expect(screen.getByTestId('message-list')).toHaveAttribute('data-has-on-regenerate', 'true');
    });

    it('passes onEdit to MessageList when provided', () => {
      const messages: Message[] = [
        { id: '1', conversationId: 'conv-1', role: 'user', content: 'Hi', createdAt: '' },
      ];
      render(<ChatLayout {...defaultProps} messages={messages} onEdit={vi.fn()} />);

      expect(screen.getByTestId('message-list')).toHaveAttribute('data-has-on-edit', 'true');
    });

    it('passes onFork to MessageList when provided', () => {
      const messages: Message[] = [
        { id: '1', conversationId: 'conv-1', role: 'user', content: 'Hi', createdAt: '' },
      ];
      render(<ChatLayout {...defaultProps} messages={messages} onFork={vi.fn()} />);

      expect(screen.getByTestId('message-list')).toHaveAttribute('data-has-on-fork', 'true');
    });

    it('does not pass action callbacks when not provided', () => {
      const messages: Message[] = [
        { id: '1', conversationId: 'conv-1', role: 'user', content: 'Hi', createdAt: '' },
      ];
      render(<ChatLayout {...defaultProps} messages={messages} />);

      expect(screen.getByTestId('message-list')).toHaveAttribute('data-has-on-regenerate', 'false');
      expect(screen.getByTestId('message-list')).toHaveAttribute('data-has-on-edit', 'false');
      expect(screen.getByTestId('message-list')).toHaveAttribute('data-has-on-fork', 'false');
    });
  });

  describe('web search integration', () => {
    it('passes search toggle props to PromptInput for authenticated user', () => {
      render(<ChatLayout {...defaultProps} isAuthenticated={true} />);

      const input = screen.getByTestId('prompt-input');
      expect(input).toHaveAttribute('data-web-search-enabled', 'false');
      expect(input).toHaveAttribute('data-model-supports-search');
      expect(input).toHaveAttribute('data-is-authenticated', 'true');
      expect(input).toHaveAttribute('data-has-toggle-web-search', 'true');
    });

    it('passes isAuthenticated=false for unauthenticated users', () => {
      render(<ChatLayout {...defaultProps} isAuthenticated={false} />);

      const input = screen.getByTestId('prompt-input');
      expect(input).toHaveAttribute('data-is-authenticated', 'false');
    });
  });
});
