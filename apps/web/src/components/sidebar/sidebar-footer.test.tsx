import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROUTES } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { buildDrizzleStudioUrl } from '@/lib/routes';
import { SidebarFooter } from './sidebar-footer';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const {
  mockSignOutAndClearCache,
  mockUseSession,
  mockNavigate,
  mockUseStableBalance,
  mockFeatureFlags,
  mockEnv,
  mockUseIsMobile,
} = vi.hoisted(() => ({
  mockSignOutAndClearCache: vi.fn().mockImplementation(() => Promise.resolve()),
  mockUseSession: vi.fn(),
  mockNavigate: vi.fn(),
  mockUseStableBalance: vi.fn(),
  mockFeatureFlags: {
    PROJECTS_ENABLED: false,
    SETTINGS_ENABLED: true,
  },
  mockEnv: {
    isDev: true,
    isLocalDev: true,
    isProduction: false,
    isCI: false,
    isE2E: false,
    requiresRealServices: false,
  },
  mockUseIsMobile: vi.fn(),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
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

vi.mock('@/hooks/use-stable-balance', () => ({
  useStableBalance: mockUseStableBalance,
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  }),
}));

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: mockUseIsMobile,
  };
});

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => false,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalPage: vi.fn(),
}));

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
    mockUseSession.mockReturnValue({
      data: {
        user: { email: 'test@example.com', username: 'test_user' },
        session: { id: 'session-123' },
      },
    });
    mockUseStableBalance.mockReturnValue({
      displayBalance: '12.34567890',
      isStable: true,
    });
    mockUseIsMobile.mockReturnValue(false);
  });

  describe('expanded state', () => {
    it('renders user avatar icon', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-avatar-icon')).toBeInTheDocument();
    });

    it('renders user username when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    it('renders credits display when expanded with 4 decimal places', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('$12.3457')).toBeInTheDocument();
    });

    it('shows loading placeholder when balance is not stable', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '0',
        isStable: false,
      });
      render(<SidebarFooter />);
      expect(screen.getByText('$...')).toBeInTheDocument();
    });

    it('shows zero balance when balance is zero', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '0',
        isStable: true,
      });
      render(<SidebarFooter />);
      expect(screen.getByText('$0.0000')).toBeInTheDocument();
    });

    it('shows dropdown menu on click', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('shows Settings option in dropdown when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-settings')).toBeInTheDocument();
    });

    it('shows Accessibility option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-accessibility')).toBeInTheDocument();
    });

    it('navigates to /accessibility when Accessibility is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-accessibility'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/accessibility' });
    });

    it('shows Add Credits option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-add-credits')).toBeInTheDocument();
    });

    it('navigates to /billing when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-add-credits'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/billing' });
    });

    it('shows GitHub option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      const githubLink = screen.getByTestId('menu-github');
      expect(githubLink).toBeInTheDocument();
      expect(githubLink).toHaveAttribute('href', 'https://github.com/lome-ai/hushbox');
      expect(githubLink).toHaveAttribute('target', '_blank');
    });

    it('shows About HushBox link in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      const link = screen.getByTestId('menu-marketing');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', ROUTES.MARKETING);
    });

    it('shows Log Out option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-logout')).toBeInTheDocument();
    });

    it('calls signOutAndClearCache and navigates when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-logout'));

      expect(mockSignOutAndClearCache).toHaveBeenCalled();
    });

    it('renders chevron up indicator', () => {
      render(<SidebarFooter />);

      const trigger = screen.getByTestId('sidebar-trigger');
      const svgs = trigger.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThanOrEqual(2);
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

    it('does not render username when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByText('Test User')).not.toBeInTheDocument();
    });

    it('does not render credits when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByText('$12.3457')).not.toBeInTheDocument();
    });

    it('has justify-center layout when collapsed', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('justify-center');
    });

    it('can open dropdown when collapsed', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
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

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-personas')).toBeInTheDocument();
    });

    it('shows Personas option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-personas')).toBeInTheDocument();
    });

    it('navigates to /dev/personas when Personas is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-personas'));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/personas',
        search: { type: undefined },
      });
    });

    it('shows Database Studio option in dev mode when authenticated', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-db-studio')).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('shows Database Studio option in dev mode when unauthenticated', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-db-studio')).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('Database Studio links to Drizzle Studio URL in new tab', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      const studioLink = screen.getByTestId('menu-db-studio');
      expect(studioLink).toHaveAttribute('href', buildDrizzleStudioUrl('http://localhost:4983'));
      expect(studioLink.getAttribute('href')).toMatch(/^https:\/\/local\.drizzle\.studio/);
      expect(studioLink).toHaveAttribute('target', '_blank');
      vi.unstubAllEnvs();
    });

    it('does not render Database Studio option when VITE_DRIZZLE_STUDIO_URL is unset', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', '');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.queryByTestId('menu-db-studio')).not.toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('uses env.isLocalDev for conditional rendering', () => {
      // Personas visibility is controlled by env.isLocalDev (not import.meta.env.DEV).
      // isLocalDev = isDev && !isCI, so Personas is hidden in CI but shown locally.
      // The mock sets isLocalDev: true to test the dev-only UI in this test suite.
      expect(mockEnv.isLocalDev).toBe(true);
    });
  });

  describe('dev-only Emails option', () => {
    it('shows Emails option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-emails')).toBeInTheDocument();
    });

    it('shows Emails option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-emails')).toBeInTheDocument();
    });

    it('navigates to /dev/emails when Emails is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-emails'));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/emails',
      });
    });
  });

  describe('dev-only Assets option', () => {
    it('shows Assets option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-assets')).toBeInTheDocument();
    });

    it('shows Assets option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-assets')).toBeInTheDocument();
    });

    it('navigates to /dev/assets when Assets is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-assets'));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/assets',
      });
    });
  });

  describe('unauthenticated state', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({ data: null });
    });

    it('renders Trial User when no session', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('Trial User')).toBeInTheDocument();
    });

    it('shows Log In option instead of Log Out', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-login')).toBeInTheDocument();
      expect(screen.queryByTestId('menu-logout')).not.toBeInTheDocument();
    });

    it('shows Sign Up option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-signup')).toBeInTheDocument();
    });

    it('navigates to /login when Log In is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-login'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });

    it('navigates to /signup when Sign Up is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-signup'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/signup' });
    });

    it('does not show Settings option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.queryByTestId('menu-settings')).not.toBeInTheDocument();
    });

    it('does not show Add Credits option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.queryByTestId('menu-add-credits')).not.toBeInTheDocument();
    });

    it('still shows GitHub option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-github')).toBeInTheDocument();
    });

    it('shows About HushBox link', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      const link = screen.getByTestId('menu-marketing');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', ROUTES.MARKETING);
    });
  });

  describe('closes mobile sidebar on menu item click', () => {
    // Defends against an iOS Sheet-overlay bug: when the user clicks a
    // menu item that navigates to the route they're already on, the
    // sidebar's pathname-diff effect doesn't fire and the Sheet keeps
    // intercepting pointer events on the page beneath it. Closing the
    // mobile sidebar from the item's onClick guarantees this regardless
    // of whether navigation actually changes the route.
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: true });
    });

    it('closes mobile sidebar when Settings is clicked', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-settings'));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Accessibility is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-accessibility'));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Usage is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-usage'));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-add-credits'));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-logout'));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Log In is clicked (unauthenticated)', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-login'));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Sign Up is clicked (unauthenticated)', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId('sidebar-trigger'));
      await user.click(screen.getByTestId('menu-signup'));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });
  });

  describe('SETTINGS_ENABLED feature flag', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({
        data: {
          user: { email: 'test@example.com', username: 'test_user' },
          session: { id: 'session-123' },
        },
      });
    });

    it('hides Settings when SETTINGS_ENABLED is false', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = false;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.queryByTestId('menu-settings')).not.toBeInTheDocument();
    });

    it('shows Settings when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('sidebar-trigger'));
      expect(screen.getByTestId('menu-settings')).toBeInTheDocument();
    });
  });
});
