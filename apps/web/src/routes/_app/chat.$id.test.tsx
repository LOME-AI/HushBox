import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock TanStack Router
const redirectError = new Error('REDIRECT');
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(
    () => (config: { beforeLoad?: () => Promise<void>; component?: unknown }) => config
  ),
  redirect: vi.fn(() => {
    throw redirectError;
  }),
}));

// Mock auth
const mockRequireAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

// Mock error boundary
vi.mock('@/components/shared/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock authenticated chat page
vi.mock('@/components/chat/authenticated-chat-page', () => ({
  AuthenticatedChatPage: () => <div data-testid="authenticated-chat">chat page</div>,
}));

describe('chat.$id route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls requireAuth in beforeLoad', async () => {
    mockRequireAuth.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      },
    });

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as {
      beforeLoad?: () => Promise<void>;
    };

    expect(routeConfig.beforeLoad).toBeDefined();
    await routeConfig.beforeLoad!();
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('redirects to login when auth fails', async () => {
    mockRequireAuth.mockRejectedValue(redirectError);

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as {
      beforeLoad?: () => Promise<void>;
    };

    await expect(routeConfig.beforeLoad!()).rejects.toThrow('REDIRECT');
  });
});
