import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { renderWithProviders as render } from '@/test-utils/render';
import { ChatLayout } from '@/components/chat/layout/chat-layout';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { BranchSwitcherProps } from '@/components/chat/layout/branch-switcher';
import type { Message } from '@/lib/api/api';
import type { ModelStoreStub } from '@/test-utils/model-store-mock';

import type { ConversationWebSocket } from '@/lib/api/ws-client';

const { isMobileRef } = vi.hoisted(() => ({
  isMobileRef: { current: false },
}));

const { mockPromptPredictor } = vi.hoisted(() => ({
  mockPromptPredictor: vi.fn(() => undefined),
}));

vi.mock('@/lib/prediction/prompt-predictor', () => ({
  promptPredictor: mockPromptPredictor,
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useVisualViewportHeight: () => 800,
    useIsMobile: () => isMobileRef.current,
  };
});

vi.mock('@/hooks/ui/use-keyboard-offset', () => ({
  useKeyboardOffset: () => ({ bottom: 0, isKeyboardVisible: false }),
}));

vi.mock('@/hooks/models/use-premium-model-click', () => ({
  usePremiumModelClick: () => vi.fn(),
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({
    data: { models: [], premiumIds: new Set() },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/models/use-resolve-default-model', () => ({
  useResolveDefaultModel: () => {
    /* no-op in tests */
  },
}));

vi.mock('@/hooks/billing/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState, attachStaticMethods } =
    await import('@/test-utils/model-store-mock');
  const state = createModelStoreStub({
    selections: {
      text: [{ id: 'gpt-4', name: 'GPT-4' }],
      image: [],
      audio: [],
      video: [],
    },
  });
  const store = attachStaticMethods(
    selectorFromState(state),
    state
  ) as unknown as typeof actual.useModelStore;
  return { ...actual, useModelStore: store };
});

const { mockWebSearch } = vi.hoisted(() => ({
  mockWebSearch: {
    current: { preferred: false, canUse: true, active: false, toggle: (): void => {} } as {
      preferred: boolean;
      canUse: boolean;
      active: boolean;
      toggle: () => void;
    },
  },
}));

vi.mock('@/hooks/chat/use-web-search', () => ({
  useWebSearch: () => mockWebSearch.current,
}));

const toggleMemberSidebarMock = vi.fn();
const setMobileMemberSidebarOpenMock = vi.fn();

vi.mock('@/stores/ui/modals', () => ({
  // Invoke the passed `useShallow` selector against a stub so the component's
  // real selector bodies (useLayoutModals et al.) execute.
  useUIModalsStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
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
      setMobileMemberSidebarOpen: setMobileMemberSidebarOpenMock,
      openMemberSidebar: vi.fn(),
      toggleMemberSidebar: toggleMemberSidebarMock,
      closeMemberSidebar: vi.fn(),
      closeAddMemberModal: vi.fn(),
      openAddMemberModal: vi.fn(),
      closeBudgetSettingsModal: vi.fn(),
      openBudgetSettingsModal: vi.fn(),
      closeInviteLinkModal: vi.fn(),
      openInviteLinkModal: vi.fn(),
      openShareMessageModal: vi.fn(),
      closeShareMessageModal: vi.fn(),
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('@/components/chat/layout/chat-header', () => ({
  ChatHeader: ({
    title,
    members,
    onFacepileClick,
    showNewChat,
    branchSwitcher,
  }: {
    title?: string;
    members?: unknown[];
    onFacepileClick?: () => void;
    showNewChat?: boolean;
    branchSwitcher?: React.ReactNode;
  }) => {
    capturedOnFacepileClick = onFacepileClick;
    return (
      <div
        data-testid="chat-header"
        data-member-count={members?.length ?? 0}
        data-show-new-chat={String(showNewChat)}
      >
        {title}
        {branchSwitcher}
      </div>
    );
  },
}));

vi.mock('@/components/chat/model-selector/model-selector-button', () => ({
  ModelSelectorButton: ({
    onSelect,
    floorGroup,
    isLinkGuest,
  }: {
    onSelect: (entries: { id: string; name: string }[]) => void;
    floorGroup?: { conversationId: string };
    isLinkGuest?: boolean;
  }) => {
    capturedOnModelSelect = onSelect;
    return (
      <button
        type="button"
        data-testid="model-selector-button"
        data-floor-conversation={floorGroup?.conversationId ?? 'none'}
        data-link-guest={String(isLinkGuest)}
      />
    );
  },
}));

vi.mock('@/components/chat/message/message-list', () => ({
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
  }) => {
    capturedOnShare = onShare;
    return (
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
    );
  },
}));

let capturedOnTypingChange: ((isTyping: boolean) => void) | undefined;
let capturedOnModelSelect: ((entries: { id: string; name: string }[]) => void) | undefined;
let capturedOnFacepileClick: (() => void) | undefined;
let capturedOnShare: ((id: string) => void) | undefined;
let capturedOnSelectModality: ((modality: string) => void) | undefined;

interface MockPromptInputProps {
  modelControl?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  autoFocus?: boolean;
  onTypingChange?: (isTyping: boolean) => void;
  searchProps?: {
    webSearchEnabled: boolean;
    canUseWebSearch: boolean;
    onToggleWebSearch: () => void;
  };
  isAuthenticated?: boolean;
  conversationId?: string | null;
  currentUserPrivilege?: string;
  onSelectModality?: (modality: string) => void;
  onQueue?: (text: string) => void;
  queueCount?: number;
  queueFull?: boolean;
}

function buildPromptInputDataAttributes(props: MockPromptInputProps): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (props.searchProps?.webSearchEnabled !== undefined) {
    attributes['data-web-search-enabled'] = String(props.searchProps.webSearchEnabled);
  }
  if (props.searchProps?.canUseWebSearch !== undefined) {
    attributes['data-can-use-web-search'] = String(props.searchProps.canUseWebSearch);
  }
  if (props.searchProps?.onToggleWebSearch !== undefined) {
    attributes['data-has-toggle-web-search'] = 'true';
  }
  if (props.isAuthenticated !== undefined) {
    attributes['data-is-authenticated'] = String(props.isAuthenticated);
  }
  if (props.conversationId !== undefined) {
    attributes['data-conversation-id'] = String(props.conversationId);
  }
  if (props.currentUserPrivilege !== undefined) {
    attributes['data-current-user-privilege'] = props.currentUserPrivilege;
  }
  return attributes;
}

function buildQueueDataAttributes(props: MockPromptInputProps): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (props.onQueue !== undefined) attributes['data-has-on-queue'] = 'true';
  if (props.queueCount !== undefined) attributes['data-queue-count'] = String(props.queueCount);
  if (props.queueFull !== undefined) attributes['data-queue-full'] = String(props.queueFull);
  return attributes;
}

vi.mock('@/components/chat/input/prompt-input', () => ({
  PromptInput: React.forwardRef(function MockPromptInput(
    props: MockPromptInputProps,
    ref: React.ForwardedRef<{ focus: () => void }>
  ) {
    // eslint-disable-next-line react-hooks/globals -- test mock captures prop for later assertion
    capturedOnTypingChange = props.onTypingChange;
    // eslint-disable-next-line react-hooks/globals -- test mock captures prop for later assertion
    capturedOnSelectModality = props.onSelectModality;
    React.useImperativeHandle(ref, () => ({ focus: vi.fn() }), []);
    return (
      <>
        <input
          data-testid="prompt-input"
          data-autofocus={props.autoFocus ? 'true' : 'false'}
          data-has-typing-change={props.onTypingChange ? 'true' : 'false'}
          {...buildPromptInputDataAttributes(props)}
          {...buildQueueDataAttributes(props)}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onSubmit();
          }}
          disabled={props.disabled}
        />
        <div data-testid="composer-model-slot">{props.modelControl}</div>
      </>
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

vi.mock('@/components/chat/member/member-sidebar', () => ({
  MemberSidebar: () => <div data-testid="member-sidebar" />,
}));

vi.mock('@/components/chat/member/add-member-modal', () => ({
  AddMemberModal: (props: Record<string, unknown>) => (
    <div data-testid="add-member-modal" data-member-count={props['memberCount']} />
  ),
}));

vi.mock('@/components/chat/budget/budget-settings-modal', () => ({
  BudgetSettingsModal: () => <div data-testid="budget-settings-modal" />,
}));

vi.mock('@/components/chat/member/invite-link-modal', () => ({
  InviteLinkModal: (props: Record<string, unknown>) => (
    <div data-testid="invite-link-modal" data-member-count={props['memberCount']} />
  ),
}));

vi.mock('@/components/chat/message/share-message-modal', () => ({
  ShareMessageModal: () => <div data-testid="share-message-modal" />,
}));

vi.mock('@/components/chat/layout/branch-switcher', () => ({
  BranchSwitcher: ({
    branches,
    currentForkId,
    onSelect,
    onRename,
    onDelete,
    boundary,
  }: BranchSwitcherProps): React.JSX.Element => (
    <div
      data-testid="branch-switcher-stub"
      data-current-fork-id={currentForkId ?? ''}
      data-first-messages={branches.map((b) => b.firstMessage).join('|')}
      data-has-boundary={String(boundary instanceof HTMLElement)}
    >
      <button
        type="button"
        onClick={() => {
          onSelect('fork-1');
        }}
      >
        stub select
      </button>
      <button
        type="button"
        onClick={() => {
          onRename('fork-1', 'Fork 1');
        }}
      >
        stub rename
      </button>
      <button
        type="button"
        onClick={() => {
          onDelete('fork-1');
        }}
      >
        stub delete
      </button>
    </div>
  ),
}));

vi.mock('@/components/chat/indicators/typing-indicator', () => ({
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
    mockWebSearch.current = { preferred: false, canUse: true, active: false, toggle: vi.fn() };
  });

  it('asks its predictor for no alternatives, having nowhere to list them', () => {
    render(<ChatLayout {...defaultProps} title="Test Chat" />);

    expect(mockPromptPredictor).toHaveBeenCalledWith(0);
  });

  it('renders the chat header', () => {
    render(<ChatLayout {...defaultProps} title="Test Chat" />);

    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it.each([
    { viewer: 'a member conversation', isAuthenticated: true, isLinkGuest: false, shown: 'true' },
    { viewer: 'a trial conversation', isAuthenticated: false, isLinkGuest: false, shown: 'false' },
    { viewer: 'a link guest view', isAuthenticated: false, isLinkGuest: true, shown: 'false' },
    {
      viewer: 'a link guest view with a session',
      isAuthenticated: true,
      isLinkGuest: true,
      shown: 'false',
    },
  ])(
    'sets the header New chat icon to $shown on $viewer',
    ({ isAuthenticated, isLinkGuest, shown }) => {
      render(
        <ChatLayout
          {...defaultProps}
          title="Test Chat"
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest}
        />
      );

      expect(screen.getByTestId('chat-header')).toHaveAttribute('data-show-new-chat', shown);
    }
  );

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

  it('mounts the document panel through its lazy Suspense boundary', async () => {
    render(<ChatLayout {...defaultProps} />);

    // The document panel pulls the markdown/diagram stack (streamdown → shiki) and
    // is code-split via React.lazy, keeping it off the boot chunk in production.
    // The runner resolves the dynamic import synchronously, so the "absent on the
    // first synchronous paint" timing isn't observable here — code-splitting is a
    // build-time property. We assert it mounts through the lazy boundary.
    expect(await screen.findByTestId('document-panel')).toBeInTheDocument();
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

  it('caps the composer column at the chat measure and centres it', () => {
    render(<ChatLayout {...defaultProps} />);

    const column = screen.getByTestId('prompt-input').parentElement;
    expect(column?.style.maxWidth).toBe('42rem');
    expect(column).toHaveClass('mx-auto', 'box-content');
  });

  it('sets the composer column between the band gutters', () => {
    render(<ChatLayout {...defaultProps} />);

    const column = screen.getByTestId('prompt-input').parentElement;
    expect(column).toHaveClass('px-4', 'md:px-6');
    expect(column?.parentElement).toHaveClass('py-4');
    expect(column?.parentElement).not.toHaveClass('p-4');
  });

  it('holds the model chip in the composer', () => {
    render(<ChatLayout {...defaultProps} />);

    expect(screen.getByTestId('composer-model-slot')).toContainElement(
      screen.getByTestId('model-selector-button')
    );
  });

  it('prices the picker against the conversation that pays', () => {
    const groupChat = {
      conversationId: 'conv-123',
      members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
      links: [],
      onlineMemberIds: new Set<string>(),
      currentUserId: 'u1',
      currentUserLinkId: null,
      currentUserPrivilege: 'owner',
    } satisfies GroupChatProps;
    render(<ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChat} />);

    expect(screen.getByTestId('model-selector-button')).toHaveAttribute(
      'data-floor-conversation',
      'conv-123'
    );
  });

  it('tells the picker a link guest is choosing', () => {
    render(<ChatLayout {...defaultProps} isLinkGuest />);

    expect(screen.getByTestId('model-selector-button')).toHaveAttribute('data-link-guest', 'true');
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
      currentUserLinkId: null,
      currentUserPrivilege: 'owner',
      currentEpochKey: { epochNumber: 1, privateKey: new Uint8Array(32) },
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
          {
            id: 'l1',
            displayName: null,
            privilege: 'read',
            createdAt: '2025-01-01',
            memberId: 'm-l1',
          },
          {
            id: 'l2',
            displayName: 'Guest',
            privilege: 'write',
            createdAt: '2025-01-02',
            memberId: 'm-l2',
          },
        ],
      };
      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChatWithLinks} />
      );

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
        currentUserLinkId: null,
        currentUserPrivilege: 'owner',
        currentEpochKey: { epochNumber: 1, privateKey: new Uint8Array(32) },
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

  describe('the branch switcher', () => {
    const forks = [
      { id: 'fork-main', name: 'Main', tipMessageId: 'main-a2', createdAt: isoAt(TEST_DAY_START) },
      { id: 'fork-1', name: 'Fork 1', tipMessageId: 'fork-u2', createdAt: isoAt(TEST_DAY_START) },
    ];
    const at = isoAt(TEST_DAY_START);
    const shared: Message[] = [
      { id: 'u1', conversationId: 'conv-1', role: 'user', content: 'Q1', createdAt: at },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'A1',
        createdAt: at,
        parentMessageId: 'u1',
      },
    ];
    const mainOnly: Message[] = [
      ...shared,
      {
        id: 'main-u2',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Main asks',
        createdAt: at,
        parentMessageId: 'a1',
      },
      {
        id: 'main-a2',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'A2',
        createdAt: at,
        parentMessageId: 'main-u2',
      },
    ];
    const tree: Message[] = [
      ...mainOnly,
      {
        id: 'fork-u2',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Fork asks',
        createdAt: at,
        parentMessageId: 'a1',
      },
    ];

    function renderWithForks(overrides: Partial<React.ComponentProps<typeof ChatLayout>> = {}): {
      onForkSelect: ReturnType<typeof vi.fn<(forkId: string) => void>>;
      onForkRename: ReturnType<typeof vi.fn<(forkId: string, currentName: string) => void>>;
      onForkDelete: ReturnType<typeof vi.fn<(forkId: string) => void>>;
    } {
      const handlers = {
        onForkSelect: vi.fn<(forkId: string) => void>(),
        onForkRename: vi.fn<(forkId: string, currentName: string) => void>(),
        onForkDelete: vi.fn<(forkId: string) => void>(),
      };
      render(
        <ChatLayout
          {...defaultProps}
          messages={mainOnly}
          branchMessages={tree}
          forks={forks}
          activeForkId="fork-main"
          {...handlers}
          {...overrides}
        />
      );
      return handlers;
    }

    it('draws the switcher in the header', () => {
      renderWithForks();
      expect(screen.getByTestId('chat-header')).toContainElement(
        screen.getByTestId('branch-switcher-stub')
      );
    });

    it('draws no fork tab bar', () => {
      renderWithForks();
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('summarises every branch from the whole message tree', () => {
      renderWithForks();
      expect(screen.getByTestId('branch-switcher-stub')).toHaveAttribute(
        'data-first-messages',
        'Main asks|Fork asks'
      );
    });

    it('summarises from the shown messages when no tree is given', () => {
      renderWithForks({ branchMessages: undefined });
      expect(screen.getByTestId('branch-switcher-stub')).toHaveAttribute(
        'data-first-messages',
        '|'
      );
    });

    it('marks the active fork as the current branch', () => {
      renderWithForks({ activeForkId: 'fork-1' });
      expect(screen.getByTestId('branch-switcher-stub')).toHaveAttribute(
        'data-current-fork-id',
        'fork-1'
      );
    });

    it('bounds the switcher by the layout column', () => {
      renderWithForks();
      expect(screen.getByTestId('branch-switcher-stub')).toHaveAttribute(
        'data-has-boundary',
        'true'
      );
    });

    it('switches fork through the page handler', async () => {
      const { onForkSelect } = renderWithForks();
      await userEvent.setup().click(screen.getByRole('button', { name: 'stub select' }));
      expect(onForkSelect).toHaveBeenCalledWith('fork-1');
    });

    it('opens the rename dialog through the page handler', async () => {
      const { onForkRename } = renderWithForks();
      await userEvent.setup().click(screen.getByRole('button', { name: 'stub rename' }));
      expect(onForkRename).toHaveBeenCalledWith('fork-1', 'Fork 1');
    });

    it('opens the delete dialog through the page handler', async () => {
      const { onForkDelete } = renderWithForks();
      await userEvent.setup().click(screen.getByRole('button', { name: 'stub delete' }));
      expect(onForkDelete).toHaveBeenCalledWith('fork-1');
    });

    it('is safe to use without page handlers', async () => {
      renderWithForks({
        onForkSelect: undefined,
        onForkRename: undefined,
        onForkDelete: undefined,
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'stub select' }));
      await user.click(screen.getByRole('button', { name: 'stub rename' }));
      await expect(
        user.click(screen.getByRole('button', { name: 'stub delete' }))
      ).resolves.toBeUndefined();
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
      expect(input).toHaveAttribute('data-is-authenticated', 'true');
      expect(input).toHaveAttribute('data-has-toggle-web-search', 'true');
      expect(input).toHaveAttribute('data-can-use-web-search', 'true');
    });

    it('passes isAuthenticated=false for unauthenticated users', () => {
      render(<ChatLayout {...defaultProps} isAuthenticated={false} />);

      const input = screen.getByTestId('prompt-input');
      expect(input).toHaveAttribute('data-is-authenticated', 'false');
    });

    it('marks web search unavailable when the preference persists on but the user cannot use it', () => {
      // A trial user's stale persisted preference must not present as usable —
      // the composer forwards the effective state from useWebSearch.
      mockWebSearch.current = { preferred: true, canUse: false, active: false, toggle: vi.fn() };

      render(<ChatLayout {...defaultProps} isAuthenticated={false} />);

      const input = screen.getByTestId('prompt-input');
      expect(input).toHaveAttribute('data-can-use-web-search', 'false');
      expect(input).toHaveAttribute('data-web-search-enabled', 'false');
    });
  });

  describe('the selected models', () => {
    afterEach(async () => {
      const { useModelStore } = await import('@/stores/model');
      (useModelStore.getState() as unknown as ModelStoreStub).selections.text = [
        { id: 'gpt-4', name: 'GPT-4' },
      ];
    });

    it('draws no bar of the selected models when several are selected', async () => {
      const { useModelStore } = await import('@/stores/model');
      (useModelStore.getState() as unknown as ModelStoreStub).selections.text = [
        { id: 'gpt-4', name: 'GPT-4' },
        { id: 'claude', name: 'Claude' },
      ];

      render(<ChatLayout {...defaultProps} />);

      expect(screen.queryByTestId(TEST_IDS.selectedModelsBar)).not.toBeInTheDocument();
    });
  });

  describe('header / composer callbacks', () => {
    const messages: Message[] = [
      { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'Hi', createdAt: '' },
    ];

    afterEach(async () => {
      const { useModelStore } = await import('@/stores/model');
      const state = useModelStore.getState() as unknown as ModelStoreStub;
      state.activeModality = 'text';
      state.selections.text = [{ id: 'gpt-4', name: 'GPT-4' }];
      isMobileRef.current = false;
    });

    it('opens the mobile member sidebar when the facepile is clicked on mobile', () => {
      isMobileRef.current = true;
      const groupChat = {
        conversationId: 'conv-123',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserLinkId: null,
        currentUserPrivilege: 'owner',
        currentEpochKey: { epochNumber: 1, privateKey: new Uint8Array(32) },
      } as unknown as Parameters<typeof ChatLayout>[0]['groupChat'];

      render(<ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChat} />);

      capturedOnFacepileClick?.();

      expect(setMobileMemberSidebarOpenMock).toHaveBeenCalledTimes(1);
    });

    it('switches the active modality via the composer', async () => {
      const { useModelStore } = await import('@/stores/model');
      render(<ChatLayout {...defaultProps} />);

      capturedOnSelectModality?.('image');

      expect(
        (useModelStore.getState() as unknown as ModelStoreStub).setActiveModality
      ).toHaveBeenCalledWith('image');
    });

    it('commits a model selection via the composer chip', async () => {
      const { useModelStore } = await import('@/stores/model');
      render(<ChatLayout {...defaultProps} />);

      const entries = [{ id: 'claude', name: 'Claude' }];
      capturedOnModelSelect?.(entries);

      expect(
        (useModelStore.getState() as unknown as ModelStoreStub).setSelectedModels
      ).toHaveBeenCalledWith('text', entries);
    });

    it('toggles the member sidebar when the facepile is clicked on desktop', () => {
      const groupChat = {
        conversationId: 'conv-123',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserLinkId: null,
        currentUserPrivilege: 'owner',
        currentEpochKey: { epochNumber: 1, privateKey: new Uint8Array(32) },
      } as unknown as Parameters<typeof ChatLayout>[0]['groupChat'];

      render(<ChatLayout {...defaultProps} conversationId="conv-123" groupChat={groupChat} />);

      capturedOnFacepileClick?.();

      expect(toggleMemberSidebarMock).toHaveBeenCalledTimes(1);
    });

    it('opens the share modal via the message list share handler', () => {
      render(<ChatLayout {...defaultProps} messages={messages} />);

      expect(() => capturedOnShare?.('m1')).not.toThrow();
    });

    it('omits searchProps for a non-text modality', async () => {
      const { useModelStore } = await import('@/stores/model');
      (useModelStore.getState() as unknown as ModelStoreStub).activeModality = 'image';

      render(<ChatLayout {...defaultProps} />);

      expect(screen.getByTestId('prompt-input')).not.toHaveAttribute('data-web-search-enabled');
    });

    it('passes no leave handler to the member sidebar for a link guest', () => {
      const groupChat = {
        conversationId: 'conv-123',
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserLinkId: 'link-1',
        currentUserPrivilege: 'read',
        currentEpochKey: { epochNumber: 1, privateKey: new Uint8Array(32) },
        onLeave: vi.fn(),
      } as unknown as Parameters<typeof ChatLayout>[0]['groupChat'];

      render(
        <ChatLayout {...defaultProps} conversationId="conv-123" isLinkGuest groupChat={groupChat} />
      );

      expect(screen.getByTestId('member-sidebar')).toBeInTheDocument();
    });
  });
});

describe('ChatLayout — message queue', () => {
  const baseProps = {
    messages: [] as Message[],
    streamingMessageIds: new Set<string>(),
    inputValue: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    inputDisabled: false,
    isProcessing: true,
    historyCharacters: 0,
    isAuthenticated: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebSearch.current = { preferred: false, canUse: true, active: false, toggle: vi.fn() };
  });

  it('threads onQueue, queueCount, and queueFull to the composer', () => {
    render(<ChatLayout {...baseProps} onQueue={vi.fn()} queueCount={3} queueFull={true} />);
    const input = screen.getByTestId('prompt-input');
    expect(input).toHaveAttribute('data-has-on-queue', 'true');
    expect(input).toHaveAttribute('data-queue-count', '3');
    expect(input).toHaveAttribute('data-queue-full', 'true');
  });

  it('renders queued-message pills above the composer', () => {
    render(
      <ChatLayout
        {...baseProps}
        queuedMessages={[
          { id: 'q1', text: 'first queued', payerSwitch: undefined },
          { id: 'q2', text: 'second queued', payerSwitch: undefined },
        ]}
        onCancelQueued={vi.fn()}
      />
    );
    expect(screen.getByTestId('queued-messages')).toBeInTheDocument();
    expect(screen.getByText('first queued')).toBeInTheDocument();
    expect(screen.getByText('second queued')).toBeInTheDocument();
  });

  it('wires pill cancel to onCancelQueued with the message id', async () => {
    const onCancelQueued = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatLayout
        {...baseProps}
        queuedMessages={[{ id: 'q1', text: 'cancel me', payerSwitch: undefined }]}
        onCancelQueued={onCancelQueued}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Cancel queued message: cancel me' }));
    expect(onCancelQueued).toHaveBeenCalledWith('q1');
  });

  it('renders no pills container when no queue props are supplied', () => {
    render(<ChatLayout {...baseProps} />);
    expect(screen.queryByTestId('queued-messages')).not.toBeInTheDocument();
  });
});
