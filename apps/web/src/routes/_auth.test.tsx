import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { redirect } from '@tanstack/react-router';
import { authClient } from '@/lib/auth';

// Mock TanStack Router
const redirectError = new Error('REDIRECT');
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => (config: { beforeLoad?: () => Promise<void> }) => config),
  Outlet: () => <div data-testid="outlet">Outlet Content</div>,
  redirect: vi.fn(() => {
    throw redirectError;
  }),
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// Mock auth client
vi.mock('@/lib/auth', () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

// Mock CipherWall to avoid Canvas API in JSDOM
vi.mock('@/components/auth/cipher-wall', () => ({
  CipherWall: () => <div data-testid="cipher-wall">cipher wall</div>,
}));

describe('AuthLayout component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders theme toggle in top-right of form area', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    await waitFor(() => {
      expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    });
  });

  it('renders logo as a link to /chat in top-left', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    await waitFor(() => {
      const logoLink = screen.getByRole('link', { name: /hushbox/i });
      expect(logoLink).toBeInTheDocument();
      expect(logoLink).toHaveAttribute('href', '/chat');
    });
  });

  it('renders split-screen layout', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    expect(screen.getByTestId('auth-layout')).toBeInTheDocument();
  });

  it('renders outlet for child content', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('has split-screen flex layout', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    const container = screen.getByTestId('auth-layout');
    expect(container).toHaveClass('min-h-dvh');
    expect(container).toHaveClass('flex');
  });

  it('renders cipher wall in right column', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    expect(screen.getByTestId('cipher-wall')).toBeInTheDocument();
  });

  it('allows vertical scrolling when content exceeds viewport', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    const container = screen.getByTestId('auth-layout');
    // Auth layout uses min-h-dvh and relies on normal document scrolling
    // (no overflow:hidden on parent containers)
    expect(container).toHaveClass('min-h-dvh');
    expect(container).not.toHaveClass('overflow-hidden');
  });
});

describe('Auth route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to /chat when user is authenticated', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
        },
      },
    });

    const { Route } = await import('./_auth');
    const routeWithBeforeLoad = Route as unknown as {
      beforeLoad?: () => Promise<void>;
    };

    await expect(routeWithBeforeLoad.beforeLoad?.()).rejects.toThrow('REDIRECT');
    expect(redirect).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('does not redirect when user is not authenticated', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
    });

    const { Route } = await import('./_auth');
    const routeWithBeforeLoad = Route as unknown as {
      beforeLoad?: () => Promise<void>;
    };

    await routeWithBeforeLoad.beforeLoad?.();

    expect(redirect).not.toHaveBeenCalled();
  });
});
