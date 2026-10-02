import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { createAuthServerFixture, resetAuthEnvironment } from '@/test-utils/auth-server-fixture';

const { mockUseLocation } = vi.hoisted(() => ({ mockUseLocation: vi.fn(() => ({ state: {} })) }));

// `useLocation` needs a router this harness has no reason to build; everything
// else from the module — `createFileRoute`, and the `redirect` auth throws on a
// failed gate — stays real, because the gate under test is the real one.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useLocation: () => mockUseLocation() };
});

vi.mock('@/providers/query-provider', () => ({
  queryClient: {
    clear: vi.fn(),
    // Delegates to the queryFn so every bootstrap read hits the fixture's server.
    fetchQuery: vi.fn((options: { queryFn: () => unknown }) => options.queryFn()),
  },
  registerSessionRevocationClearer: vi.fn(),
}));

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: { unregister: vi.fn(() => Promise.resolve()) },
}));

vi.mock('@/components/chat/page/authenticated-chat-page', () => ({
  AuthenticatedChatPage: ({ routeConversationId }: { routeConversationId: string }) => (
    <div data-testid="authenticated-chat">{routeConversationId}</div>
  ),
}));

vi.mock('@/hooks/chat/chat', () => ({
  conversationQueryOptions: vi.fn(() => ({
    queryKey: ['chat', 'conversations'],
    queryFn: vi.fn(),
  })),
}));
vi.mock('@/hooks/crypto/keys', () => ({
  keyChainQueryOptions: vi.fn(() => ({ queryKey: ['keys'], queryFn: vi.fn() })),
}));

import { useAuthStore } from '@/lib/auth/auth';
import { persistExportKey } from '@/lib/auth/client';
import { Route } from './chat.$id';
import type { AuthServerFixture } from '@/test-utils/auth-server-fixture';

interface BeforeLoadArgs {
  params: { id: string };
  context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
}

function getBeforeLoad(): (args: BeforeLoadArgs) => Promise<void> {
  const beforeLoad = Route.options.beforeLoad as
    | ((args: BeforeLoadArgs) => Promise<void>)
    | undefined;
  expect(beforeLoad).toBeDefined();
  return beforeLoad!;
}

describe('chat.$id against a real auth bootstrap', () => {
  let fixture: AuthServerFixture;

  beforeAll(async () => {
    fixture = await createAuthServerFixture();
  });

  beforeEach(() => {
    resetAuthEnvironment(fixture);
    vi.spyOn(Route, 'useParams').mockReturnValue({ id: 'conv-123' });
    vi.spyOn(Route, 'useSearch').mockReturnValue({ fork: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mounts while the instruction read is still open', async () => {
    await persistExportKey(fixture.exportKey, fixture.userId, true);
    fixture.serve('/account/instructions', () => new Promise<Response>(() => {}));

    await getBeforeLoad()({
      params: { id: 'conv-123' },
      context: { queryClient: { prefetchQuery: vi.fn() } },
    });
    renderRoute(Route);

    expect(useAuthStore.getState().user).toEqual(fixture.user);
    expect(useAuthStore.getState().customInstructionsStatus).toBe('pending');
    expect(screen.getByTestId('authenticated-chat')).toBeInTheDocument();
  });
});
