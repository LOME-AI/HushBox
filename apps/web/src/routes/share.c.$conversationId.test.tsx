import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { deriveLinkAuthToken } from '@hushbox/crypto';
import { TEST_IDS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './share.c.$conversationId';
import type { AnyRoute, AnyRouter } from '@tanstack/react-router';
import type { KeyPair, deriveKeysFromLinkSecret } from '@hushbox/crypto';
import type { fromBase64, toBase64 } from '@hushbox/shared';

const {
  mockDeriveKeysFromLinkSecret,
  mockFromBase64,
  mockToBase64,
  mockSetLinkGuestAuth,
  mockClearLinkGuestAuth,
  mockClearEpochKeyCache,
  mockClearDecryptedMessageCache,
  mockAuthenticatedChatPage,
} = vi.hoisted(() => ({
  mockDeriveKeysFromLinkSecret: vi.fn<typeof deriveKeysFromLinkSecret>(),
  mockFromBase64: vi.fn<typeof fromBase64>(),
  mockToBase64: vi.fn<typeof toBase64>(),
  mockSetLinkGuestAuth: vi.fn(),
  mockClearLinkGuestAuth: vi.fn(),
  mockClearEpochKeyCache: vi.fn(),
  mockClearDecryptedMessageCache: vi.fn(),
  mockAuthenticatedChatPage: vi.fn<(props: Record<string, unknown>) => void>(),
}));

// Keep the real link-auth derivation, so the credential asserted below is the one
// the server hashes; only the keypair derivation is stood in for.
vi.mock(import('@hushbox/crypto'), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveKeysFromLinkSecret: mockDeriveKeysFromLinkSecret,
}));

// Keep the real @hushbox/shared (TEST_IDS etc.); override only the base64 codecs.
vi.mock(import('@hushbox/shared'), async (importOriginal) => ({
  ...(await importOriginal()),
  fromBase64: mockFromBase64,
  toBase64: mockToBase64,
}));

// Keep the real router (createFileRoute must run for the route file); mock only useParams.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useParams: () => ({ conversationId: 'conv-shared' }),
  };
});

vi.mock('../lib/auth/link-guest-auth.js', () => ({
  setLinkGuestAuth: (...args: unknown[]) => mockSetLinkGuestAuth(...args),
  clearLinkGuestAuth: (...args: unknown[]) => mockClearLinkGuestAuth(...args),
}));

vi.mock('@/lib/crypto/epoch-key-cache.js', () => ({
  clearEpochKeyCache: (...args: unknown[]) => mockClearEpochKeyCache(...args),
}));

vi.mock('@/lib/crypto/decrypted-message-cache.js', () => ({
  clearDecryptedMessageCache: (...args: unknown[]) => mockClearDecryptedMessageCache(...args),
}));

vi.mock('../components/shared/app-shell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock('@/components/chat/page/authenticated-chat-page.js', () => ({
  AuthenticatedChatPage: (props: Record<string, unknown>): React.JSX.Element => {
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

// The page shell draws the theme toggle, which reads the app's theme provider; the
// strict-mode harnesses below mount without the provider stack.
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: 'light', triggerTransition: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <>{children}</>
  ),
}));

const { toBase64: realToBase64 } =
  await vi.importActual<typeof import('@hushbox/shared')>('@hushbox/shared');

const LINK_SECRET = new Uint8Array(32).fill(7);
const FAKE_PUBLIC_KEY = new Uint8Array(32).fill(42);
const FAKE_PRIVATE_KEY = new Uint8Array(32).fill(43);

/** Every keypair the route derived during the test, oldest first. */
let derivedKeys: KeyPair[] = [];

/** The private key the chat page most recently rendered with. */
function chatPagePrivateKey(): Uint8Array {
  const [props] = mockAuthenticatedChatPage.mock.lastCall!;
  return (props as { privateKeyOverride: Uint8Array }).privateKeyOverride;
}

const SHARE_PATH = '/share/c/conv-shared';
const AWAY_PATH = '/';
const AWAY_TEST_ID = 'away-page';

/**
 * `<StrictMode>` has to be the outermost element handed to `render`: React only
 * double-invokes effects for a subtree whose root element is the StrictMode one,
 * so a harness that nests it under a provider wrapper — `renderWithProviders` —
 * cannot see a mount-time effect cleanup at all. This mirrors `main.tsx`, where
 * StrictMode wraps the RouterProvider at the root.
 */
function renderStrictMode(children: React.ReactNode): void {
  render(
    <React.StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        {children}
      </QueryClientProvider>
    </React.StrictMode>
  );
}

function renderStrictModeRoute(): void {
  const RouteComponent = Route.options.component!;
  renderStrictMode(<RouteComponent />);
}

/**
 * Mount the route through a real router over memory history, so leaving is a
 * genuine router transition rather than a bare React unmount.
 */
async function renderRoutedApp(): Promise<AnyRouter> {
  const rootRoute = createRootRoute();
  // The generated route tree grafts every file route onto its parent through an
  // untyped `update`, because a file route's parent is only known once it is placed
  // on a tree; this test builds the same graft by hand.
  const graft = Route.update as unknown as (options: unknown) => AnyRoute;
  const shareRoute = graft({
    id: SHARE_PATH,
    path: SHARE_PATH,
    getParentRoute: () => rootRoute,
  });
  const awayRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: AWAY_PATH,
    component: (): React.JSX.Element => <div data-testid={AWAY_TEST_ID} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shareRoute, awayRoute]),
    history: createMemoryHistory({ initialEntries: [AWAY_PATH, SHARE_PATH] }),
  });

  renderStrictMode(<RouterProvider router={router} />);
  await screen.findByTestId('authenticated-chat-page');
  return router;
}

describe('/share/c/$conversationId route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(QueryClient.prototype, 'invalidateQueries').mockImplementation(() =>
      Promise.resolve()
    );
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#bGluay1zZWNyZXQtYjY0', reload: vi.fn() },
      writable: true,
    });
    derivedKeys = [];
    mockFromBase64.mockImplementation(() => LINK_SECRET);
    mockToBase64.mockImplementation((bytes) => realToBase64(bytes));
    // A fresh key object per derivation, as the real derivation returns. Guest-exit
    // zeros a derived key in place, so a single object shared by every derivation
    // would make an abandoned key indistinguishable from the live one.
    mockDeriveKeysFromLinkSecret.mockImplementation(() => {
      const keys: KeyPair = {
        publicKey: FAKE_PUBLIC_KEY,
        privateKey: Uint8Array.from(FAKE_PRIVATE_KEY),
      };
      derivedKeys.push(keys);
      return keys;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders AppShell wrapping AuthenticatedChatPage', () => {
    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.appShell)).toBeInTheDocument();
    expect(screen.getByTestId('authenticated-chat-page')).toBeInTheDocument();
  });

  it('renders the chat page inside the page shell, so its header has slots to fill', () => {
    renderRoute(Route);

    const region = document.querySelector('[data-page-slot="region"]');
    expect(region).toContainElement(screen.getByTestId('authenticated-chat-page'));
    expect(screen.getByTestId(TEST_IDS.appShell)).toContainElement(
      document.querySelector('header')
    );
  });

  it('passes conversationId to AuthenticatedChatPage', () => {
    renderRoute(Route);

    expect(screen.getByTestId('authenticated-chat-page')).toHaveAttribute(
      'data-conversation-id',
      'conv-shared'
    );
  });

  it('passes privateKeyOverride to AuthenticatedChatPage', () => {
    renderRoute(Route);

    expect(mockAuthenticatedChatPage).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKeyOverride: FAKE_PRIVATE_KEY,
      })
    );
  });

  it('derives keys from the URL hash fragment', () => {
    renderRoute(Route);

    expect(mockFromBase64).toHaveBeenCalledWith('bGluay1zZWNyZXQtYjY0');
    expect(mockDeriveKeysFromLinkSecret).toHaveBeenCalled();
  });

  it('sets link guest auth to the auth token derived from the link secret', () => {
    renderRoute(Route);

    expect(mockSetLinkGuestAuth).toHaveBeenCalledWith(
      realToBase64(deriveLinkAuthToken(LINK_SECRET))
    );
  });

  it('never presents the link public key as the guest credential', () => {
    renderRoute(Route);

    expect(mockSetLinkGuestAuth).toHaveBeenCalled();
    expect(mockSetLinkGuestAuth).not.toHaveBeenCalledWith(realToBase64(FAKE_PUBLIC_KEY));
  });

  it('clears link guest auth on unmount', () => {
    const { unmount } = renderRoute(Route);

    expect(mockClearLinkGuestAuth).not.toHaveBeenCalled();
    unmount();
    expect(mockClearLinkGuestAuth).toHaveBeenCalled();
  });

  it('zeros the guest-derived private key on unmount', () => {
    const { unmount } = renderRoute(Route);
    const { privateKey } = derivedKeys[0]!;

    expect(privateKey.some((byte) => byte !== 0)).toBe(true);
    unmount();
    expect(privateKey.every((byte) => byte === 0)).toBe(true);
  });

  it('clears the epoch and decrypted-message caches on unmount', () => {
    const { unmount } = renderRoute(Route);

    expect(mockClearEpochKeyCache).not.toHaveBeenCalled();
    expect(mockClearDecryptedMessageCache).not.toHaveBeenCalled();
    unmount();
    expect(mockClearEpochKeyCache).toHaveBeenCalled();
    expect(mockClearDecryptedMessageCache).toHaveBeenCalled();
  });

  // StrictMode double-invokes effects, so an exit reload hung on effect cleanup
  // fires while the guest is still on the route. Only a StrictMode-wrapped render
  // can see that; `renderRoute` cannot.
  it('does not reload while the guest is still on the route', () => {
    renderStrictModeRoute();

    expect(globalThis.location.reload).not.toHaveBeenCalled();
  });

  // React double-invokes effects in a development build: setup, cleanup, setup.
  // A key derived once per render is therefore zeroed by the first cleanup while
  // the second setup is still using it, which decrypts nothing.
  it('hands the chat page a live key under a double-invoked build', () => {
    renderStrictModeRoute();

    expect(chatPagePrivateKey().some((byte) => byte !== 0)).toBe(true);
  });

  it('zeros the key abandoned by a double-invoked build', () => {
    renderStrictModeRoute();

    const live = chatPagePrivateKey();
    const abandoned = derivedKeys.map((keys) => keys.privateKey).filter((key) => key !== live);

    expect(abandoned).not.toHaveLength(0);
    expect(abandoned.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });

  it('reloads once when the router leaves the route', async () => {
    const router = await renderRoutedApp();

    await act(async () => {
      await router.navigate({ to: AWAY_PATH });
    });
    await screen.findByTestId(AWAY_TEST_ID);

    expect(globalThis.location.reload).toHaveBeenCalledOnce();
  });

  it('reloads once when the guest goes back out of the route', async () => {
    const router = await renderRoutedApp();

    router.history.back();
    await screen.findByTestId(AWAY_TEST_ID);

    expect(globalThis.location.reload).toHaveBeenCalledOnce();
  });

  it('does not reload when only the inner page remounts on a link switch', () => {
    renderRoute(Route);

    (globalThis.location as { hash: string }).hash = '#bmV3LXNlY3JldA';
    act(() => {
      globalThis.dispatchEvent(new Event('hashchange'));
    });

    expect(globalThis.location.reload).not.toHaveBeenCalled();
  });

  it('passes has-private-key data attribute', () => {
    renderRoute(Route);

    expect(screen.getByTestId('authenticated-chat-page')).toHaveAttribute(
      'data-has-private-key',
      'true'
    );
  });

  it('invalidates all query cache on mount', () => {
    renderRoute(Route);

    expect(QueryClient.prototype.invalidateQueries).toHaveBeenCalledWith();
  });

  it('renders error state when key derivation fails', () => {
    mockDeriveKeysFromLinkSecret.mockImplementation(() => {
      throw new Error('invalid key');
    });

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedConversationError)).toBeInTheDocument();
    expect(screen.queryByTestId('authenticated-chat-page')).not.toBeInTheDocument();
  });

  it('renders error state when the link secret is the wrong length', () => {
    // A secret that is not exactly 32 bytes fails the length check and yields
    // no derived keys, short-circuiting before deriveKeysFromLinkSecret.
    mockFromBase64.mockImplementation(() => new Uint8Array(16));

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedConversationError)).toBeInTheDocument();
    expect(mockDeriveKeysFromLinkSecret).not.toHaveBeenCalled();
  });

  it('renders error state when the URL fragment is not valid base64', () => {
    mockFromBase64.mockImplementation(() => {
      throw new Error('not base64');
    });

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedConversationError)).toBeInTheDocument();
    expect(mockDeriveKeysFromLinkSecret).not.toHaveBeenCalled();
  });

  it('remounts the inner page when the URL hash changes', () => {
    renderRoute(Route);

    expect(mockFromBase64).toHaveBeenLastCalledWith('bGluay1zZWNyZXQtYjY0');

    // A hash-only navigation does not re-render the route, so the wrapper listens
    // for hashchange and remounts the inner component via key={hash}, which
    // re-derives keys from the new fragment.
    (globalThis.location as { hash: string }).hash = '#bmV3LXNlY3JldA';
    act(() => {
      globalThis.dispatchEvent(new Event('hashchange'));
    });

    expect(mockFromBase64).toHaveBeenLastCalledWith('bmV3LXNlY3JldA');
  });
});
