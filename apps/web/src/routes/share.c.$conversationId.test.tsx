import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDeriveKeysFromLinkSecret = vi.fn();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();
const mockToBase64 = vi.fn<(bytes: Uint8Array) => string>();

vi.mock('@hushbox/crypto', () => ({
  deriveKeysFromLinkSecret: (...args: unknown[]) => mockDeriveKeysFromLinkSecret(...args),
}));

vi.mock('@hushbox/shared', () => ({
  fromBase64: (b64: string) => mockFromBase64(b64),
  toBase64: (bytes: Uint8Array) => mockToBase64(bytes),
}));

const mockSetLinkGuestAuth = vi.fn();
const mockClearLinkGuestAuth = vi.fn();

vi.mock('../lib/link-guest-auth.js', () => ({
  setLinkGuestAuth: (...args: unknown[]) => mockSetLinkGuestAuth(...args),
  clearLinkGuestAuth: (...args: unknown[]) => mockClearLinkGuestAuth(...args),
}));

vi.mock('../components/shared/app-shell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

const mockAuthenticatedChatPage = vi.fn();
vi.mock('../components/chat/authenticated-chat-page.js', () => ({
  AuthenticatedChatPage: (props: Record<string, unknown>) => {
    mockAuthenticatedChatPage(props);
    return (
      <div
        data-testid="authenticated-chat-page"
        data-conversation-id={props['routeConversationId'] as string}
        data-has-private-key={props['privateKeyOverride'] ? 'true' : 'false'}
      />
    );
  },
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => {
    const routeObject = {
      component: undefined as unknown,
      useParams: () => ({ conversationId: 'conv-shared' }),
    };
    return (config: { component: unknown }) => {
      routeObject.component = config.component;
      return routeObject;
    };
  },
}));

import { SharedConversationPage } from './share.c.$conversationId.js';

// ---------------------------------------------------------------------------
// Test Data
// ---------------------------------------------------------------------------

const FAKE_PUBLIC_KEY = new Uint8Array(32).fill(42);
const FAKE_PRIVATE_KEY = new Uint8Array(32).fill(43);

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
    mockToBase64.mockImplementation(() => 'base64-public-key');
    mockDeriveKeysFromLinkSecret.mockReturnValue({
      publicKey: FAKE_PUBLIC_KEY,
      privateKey: FAKE_PRIVATE_KEY,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders AppShell wrapping AuthenticatedChatPage', () => {
    render(<SharedConversationPage />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('authenticated-chat-page')).toBeInTheDocument();
  });

  it('passes conversationId to AuthenticatedChatPage', () => {
    render(<SharedConversationPage />);

    expect(screen.getByTestId('authenticated-chat-page')).toHaveAttribute(
      'data-conversation-id',
      'conv-shared'
    );
  });

  it('passes privateKeyOverride to AuthenticatedChatPage', () => {
    render(<SharedConversationPage />);

    expect(mockAuthenticatedChatPage).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKeyOverride: FAKE_PRIVATE_KEY,
      })
    );
  });

  it('derives keys from the URL hash fragment', () => {
    render(<SharedConversationPage />);

    expect(mockFromBase64).toHaveBeenCalledWith('bGluay1zZWNyZXQtYjY0');
    expect(mockDeriveKeysFromLinkSecret).toHaveBeenCalled();
  });

  it('sets link guest auth with the derived public key', () => {
    render(<SharedConversationPage />);

    expect(mockSetLinkGuestAuth).toHaveBeenCalledWith('base64-public-key');
  });

  it('clears link guest auth on unmount', () => {
    const { unmount } = render(<SharedConversationPage />);

    expect(mockClearLinkGuestAuth).not.toHaveBeenCalled();
    unmount();
    expect(mockClearLinkGuestAuth).toHaveBeenCalled();
  });

  it('passes has-private-key data attribute', () => {
    render(<SharedConversationPage />);

    expect(screen.getByTestId('authenticated-chat-page')).toHaveAttribute(
      'data-has-private-key',
      'true'
    );
  });

  it('renders error state when key derivation fails', () => {
    mockDeriveKeysFromLinkSecret.mockImplementation(() => {
      throw new Error('invalid key');
    });

    render(<SharedConversationPage />);

    expect(screen.getByTestId('shared-conversation-error')).toBeInTheDocument();
    expect(screen.queryByTestId('authenticated-chat-page')).not.toBeInTheDocument();
  });
});
