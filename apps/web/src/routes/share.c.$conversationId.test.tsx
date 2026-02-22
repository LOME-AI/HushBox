import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockProcessKeyChain = vi.fn();
const mockGetEpochKey =
  vi.fn<(conversationId: string, epochNumber: number) => Uint8Array | undefined>();

vi.mock('../lib/epoch-key-cache', () => ({
  processKeyChain: (...args: unknown[]) => mockProcessKeyChain(...args),
  getEpochKey: (conversationId: string, epochNumber: number) =>
    mockGetEpochKey(conversationId, epochNumber),
}));

const mockDecryptMessage = vi.fn<(epochPrivateKey: Uint8Array, blob: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  decryptMessage: (key: Uint8Array, blob: Uint8Array) => mockDecryptMessage(key, blob),
  fromBase64: (b64: string) => mockFromBase64(b64),
}));

vi.mock('../hooks/use-shared-conversation.js', () => ({
  useSharedConversation: vi.fn(),
}));

vi.mock('../components/shared/app-shell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock('../components/chat/chat-layout.js', () => ({
  ChatLayout: ({
    messages,
    inputDisabled,
    title,
    groupChat,
  }: {
    messages: { role: string; content: string }[];
    inputDisabled: boolean;
    title?: string;
    groupChat?: { conversationId: string; members: unknown[]; links: unknown[] };
  }) => (
    <div
      data-testid="chat-layout"
      data-input-disabled={String(inputDisabled)}
      data-message-count={messages.length}
      data-title={title}
      data-has-group-chat={groupChat ? 'true' : 'false'}
      data-group-member-count={groupChat?.members.length ?? 0}
      data-group-link-count={groupChat?.links.length ?? 0}
    >
      {messages.map((m, index) => (
        <div
          key={index}
          data-testid={`message-${String(index)}`}
          data-role={m.role}
          data-content={m.content}
        >
          {m.content}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => {
    const routeObject = {
      component: undefined as unknown,
      useParams: () => ({ conversationId: 'conv-from-route' }),
    };
    return (config: { component: unknown }) => {
      routeObject.component = config.component;
      return routeObject;
    };
  },
}));

import { useSharedConversation } from '../hooks/use-shared-conversation.js';
import { SharedConversationPage } from './share.c.$conversationId.js';

const mockUseSharedConversation = vi.mocked(useSharedConversation);

// ---------------------------------------------------------------------------
// Test Data
// ---------------------------------------------------------------------------

const EPOCH_KEY = new Uint8Array([99, 88, 77]);
const LINK_PRIVATE_KEY = new Uint8Array([10, 20, 30]);

const FAKE_DATA = {
  conversation: {
    id: 'conv-from-route',
    title: 'ZW5jcnlwdGVkLXRpdGxl',
    currentEpoch: 1,
    titleEpochNumber: 1,
  },
  privilege: 'read',
  wraps: [
    {
      epochNumber: 1,
      wrap: 'wrapped-key',
      confirmationHash: 'hash',
      privilege: 'read',
      visibleFromEpoch: 1,
    },
  ],
  chainLinks: [],
  members: [
    { id: 'member-owner', userId: 'user-1', username: 'alice', privilege: 'owner' },
    { id: 'member-link', userId: null, username: null, privilege: 'read' },
  ],
  links: [
    {
      id: 'link-1',
      displayName: 'Guest Link',
      privilege: 'read',
      createdAt: '2024-01-01T00:00:00Z',
    },
  ],
  messages: [
    {
      id: 'msg-1',
      conversationId: 'conv-from-route',
      encryptedBlob: 'YmxvYi0x',
      senderType: 'user',
      senderId: 'user-1',
      senderDisplayName: 'Alice',
      payerId: null,
      cost: null,
      epochNumber: 1,
      sequenceNumber: 1,
      createdAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'msg-2',
      conversationId: 'conv-from-route',
      encryptedBlob: 'YmxvYi0y',
      senderType: 'ai',
      senderId: null,
      senderDisplayName: null,
      payerId: 'user-1',
      cost: '0.05',
      epochNumber: 1,
      sequenceNumber: 2,
      createdAt: '2024-01-01T00:01:00Z',
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedConversationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#bGluay1zZWNyZXQtYjY0' },
      writable: true,
    });
    mockFromBase64.mockImplementation((b64: string) => new TextEncoder().encode(b64));
    mockGetEpochKey.mockReturnValue(EPOCH_KEY);
    mockDecryptMessage.mockImplementation((_key, _blob) => 'decrypted content');
  });

  it('renders loading state when data is loading', () => {
    mockUseSharedConversation.mockReturnValue({
      data: undefined,
      linkPrivateKey: null,
      isLoading: true,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('shared-conversation-loading')).toBeInTheDocument();
  });

  it('renders error state wrapped in AppShell when hook returns error', () => {
    mockUseSharedConversation.mockReturnValue({
      data: undefined,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: true,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('shared-conversation-error')).toBeInTheDocument();
  });

  it('renders AppShell with ChatLayout when data loads', () => {
    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
  });

  it('disables input for read-only guests', () => {
    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-input-disabled', 'true');
  });

  it('enables input for write guests', () => {
    mockUseSharedConversation.mockReturnValue({
      data: { ...FAKE_DATA, privilege: 'write' },
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-input-disabled', 'false');
  });

  it('passes hash fragment as linkPrivateKeyBase64 to hook', () => {
    mockUseSharedConversation.mockReturnValue({
      data: undefined,
      linkPrivateKey: null,
      isLoading: true,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(mockUseSharedConversation).toHaveBeenCalledWith(
      'conv-from-route',
      'bGluay1zZWNyZXQtYjY0'
    );
  });

  it('calls processKeyChain with link private key', () => {
    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(mockProcessKeyChain).toHaveBeenCalledWith(
      'conv-from-route',
      {
        wraps: FAKE_DATA.wraps,
        chainLinks: FAKE_DATA.chainLinks,
        currentEpoch: FAKE_DATA.conversation.currentEpoch,
      },
      LINK_PRIVATE_KEY
    );
  });

  it('decrypts messages using epoch keys', () => {
    mockDecryptMessage
      .mockReturnValueOnce('Decrypted Title') // title decryption
      .mockReturnValueOnce('Hello from user')
      .mockReturnValueOnce('Hello from AI');

    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    const msg0 = screen.getByTestId('message-0');
    expect(msg0).toHaveAttribute('data-role', 'user');
    expect(msg0).toHaveAttribute('data-content', 'Hello from user');

    const msg1 = screen.getByTestId('message-1');
    expect(msg1).toHaveAttribute('data-role', 'assistant');
    expect(msg1).toHaveAttribute('data-content', 'Hello from AI');

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-message-count', '2');
  });

  it('shows decryption failure message for missing epoch key', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument
    mockGetEpochKey.mockReturnValue(undefined);

    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    const msg0 = screen.getByTestId('message-0');
    expect(msg0).toHaveAttribute('data-content', '[decryption failed: missing epoch key]');
  });

  it('shows decryption failure message when decryptMessage throws', () => {
    mockDecryptMessage.mockImplementation(() => {
      throw new Error('bad blob');
    });

    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    const msg0 = screen.getByTestId('message-0');
    expect(msg0).toHaveAttribute('data-content', '[decryption failed]');
  });

  it('decrypts conversation title', () => {
    mockDecryptMessage.mockReturnValue('Decrypted Title');

    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-title', 'Decrypted Title');
  });

  it('shows fallback title when title decryption fails', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument
    mockGetEpochKey.mockReturnValue(undefined);

    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-title', 'Shared Conversation');
  });

  it('passes groupChat to ChatLayout with members and links', () => {
    mockDecryptMessage.mockReturnValue('decrypted content');

    mockUseSharedConversation.mockReturnValue({
      data: FAKE_DATA,
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-has-group-chat', 'true');
    // Only real users (non-null userId/username) are passed as members; link-based members are filtered out
    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-group-member-count', '1');
    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-group-link-count', '1');
  });

  it('passes decrypted title to ChatLayout', () => {
    mockDecryptMessage.mockReturnValue('My Chat Title');

    mockUseSharedConversation.mockReturnValue({
      data: { ...FAKE_DATA, messages: [] },
      linkPrivateKey: LINK_PRIVATE_KEY,
      isLoading: false,
      isError: false,
      isFetching: false,
      isStale: false,
    } as ReturnType<typeof useSharedConversation>);

    render(<SharedConversationPage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-title', 'My Chat Title');
  });
});
