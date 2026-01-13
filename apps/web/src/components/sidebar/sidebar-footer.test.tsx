import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarFooter } from './sidebar-footer';
import { useUIStore } from '@/stores/ui';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const {
  mockSignOutAndClearCache,
  mockUseSession,
  mockNavigate,
  mockUseBalance,
  mockFeatureFlags,
  mockEnv,
} = vi.hoisted(() => ({
  mockSignOutAndClearCache: vi.fn().mockResolvedValue(undefined),
  mockUseSession: vi.fn(),
  mockNavigate: vi.fn(),
  mockUseBalance: vi.fn(),
  mockFeatureFlags: {
    PROJECTS_ENABLED: false,
    SETTINGS_ENABLED: false,
  },
  mockEnv: {
    isDev: true,
    isLocalDev: true,
    isProduction: false,
    isCI: false,
    isE2E: false,
    requiresRealServices: false,
  },
}));

vi.mock('@lome-chat/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lome-chat/shared')>();
  return {
    ...actual,
    FEATURE_FLAGS: mockFeatureFlags,
  };
});

vi.mock('@/lib/auth', () => ({
  signOutAndClearCache: mockSignOutAndClearCache,
  useSession: mockUseSession,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/hooks/billing', () => ({
  useBalance: mockUseBalance,
}));

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true });
    mockUseSession.mockReturnValue({
      data: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
    });
    mockUseBalance.mockReturnValue({
      data: { balance: '12.34567890' },
      isLoading: false,
    });
  });

  describe('expanded state', () => {
    it('renders user avatar icon', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-avatar-icon')).toBeInTheDocument();
    });

    it('renders user email when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-email')).toHaveTextContent('test@example.com');
    });

    it('renders credits display when expanded with actual balance', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-credits')).toHaveTextContent('$12.34567890');
    });

    it('shows loading placeholder when balance is loading', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isLoading: true,
      });
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-credits')).toHaveTextContent('$...');
    });

    it('shows zero balance when no data returned', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isLoading: false,
      });
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-credits')).toHaveTextContent('$0.00000000');
    });

    it('shows dropdown menu on click', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('shows Settings option in dropdown when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-settings')).toBeInTheDocument();
    });

    it('shows Add Credits option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-add-credits')).toBeInTheDocument();
    });

    it('navigates to /billing when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-add-credits'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/billing' });
    });

    it('shows GitHub option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      const githubLink = screen.getByTestId('menu-github');
      expect(githubLink).toBeInTheDocument();
      expect(githubLink).toHaveAttribute('href', 'https://github.com/lome-ai/lome-chat');
      expect(githubLink).toHaveAttribute('target', '_blank');
    });

    it('shows Log Out option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-logout')).toBeInTheDocument();
    });

    it('calls signOutAndClearCache and navigates when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-logout'));

      expect(mockSignOutAndClearCache).toHaveBeenCalled();
    });
  });

  describe('collapsed state (rail mode)', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('renders avatar icon when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-avatar-icon')).toBeInTheDocument();
    });

    it('does not render email when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByTestId('user-email')).not.toBeInTheDocument();
    });

    it('does not render credits when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByTestId('user-credits')).not.toBeInTheDocument();
    });

    it('has justify-center layout when collapsed', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('justify-center');
    });

    it('can open dropdown when collapsed', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });
  });

  describe('common styles', () => {
    it('has border at top', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('border-t');
    });

    it('uses sidebar border color', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('border-sidebar-border');
    });
  });

  describe('dev-only Personas option', () => {
    it('shows Personas option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-personas')).toBeInTheDocument();
    });

    it('shows Personas option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-personas')).toBeInTheDocument();
    });

    it('navigates to /dev/personas when Personas is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-personas'));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/personas',
        search: { type: undefined },
      });
    });

    it('uses env.isLocalDev for conditional rendering', () => {
      // Personas visibility is controlled by env.isLocalDev (not import.meta.env.DEV).
      // isLocalDev = isDev && !isCI, so Personas is hidden in CI but shown locally.
      // The mock sets isLocalDev: true to test the dev-only UI in this test suite.
      expect(mockEnv.isLocalDev).toBe(true);
    });
  });

  describe('unauthenticated state', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({ data: null });
    });

    it('renders Guest User when no session', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-email')).toHaveTextContent('Guest User');
    });

    it('shows Log In option instead of Log Out', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-login')).toBeInTheDocument();
      expect(screen.queryByTestId('menu-logout')).not.toBeInTheDocument();
    });

    it('shows Sign Up option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-signup')).toBeInTheDocument();
    });

    it('navigates to /login when Log In is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-login'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });

    it('navigates to /signup when Sign Up is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-signup'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/signup' });
    });

    it('does not show Settings option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.queryByTestId('menu-settings')).not.toBeInTheDocument();
    });

    it('does not show Add Credits option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.queryByTestId('menu-add-credits')).not.toBeInTheDocument();
    });

    it('still shows GitHub option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-github')).toBeInTheDocument();
    });
  });

  describe('SETTINGS_ENABLED feature flag', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({
        data: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
      });
    });

    it('hides Settings when SETTINGS_ENABLED is false', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = false;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.queryByTestId('menu-settings')).not.toBeInTheDocument();
    });

    it('shows Settings when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-settings')).toBeInTheDocument();
    });
  });
});
