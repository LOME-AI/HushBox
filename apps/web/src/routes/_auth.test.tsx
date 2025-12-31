import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('AuthLayout component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders theme toggle in top-right of form area', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders logo as a link to /chat in top-left', async () => {
    const { AuthLayout } = await import('./_auth');

    render(<AuthLayout />);

    const logoLink = screen.getByRole('link', { name: /lome/i });
    expect(logoLink).toBeInTheDocument();
    expect(logoLink).toHaveAttribute('href', '/chat');
  });

  it('renders split-screen layout with decorative header image', async () => {
    const { AuthLayout } = await import('./_auth');

    const { container } = render(<AuthLayout />);

    expect(screen.getByTestId('auth-layout')).toBeInTheDocument();
    // FlowerBox is decorative (empty alt), verify it exists by src
    const flowerBox = container.querySelector('img[src*="FlowerBoxHD"]');
    expect(flowerBox).toBeInTheDocument();
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
    expect(container).toHaveClass('min-h-screen');
    expect(container).toHaveClass('flex');
  });
});

describe('Auth route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to /chat when user is authenticated', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { id: 'session-1' } },
      error: null,
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
      error: null,
    });

    const { Route } = await import('./_auth');
    const routeWithBeforeLoad = Route as unknown as {
      beforeLoad?: () => Promise<void>;
    };

    await routeWithBeforeLoad.beforeLoad?.();

    expect(redirect).not.toHaveBeenCalled();
  });
});
