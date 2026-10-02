import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui/ui';
import { useRightPane } from '@/stores/ui/right-pane';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useTouchOverrideStore } from '@/stores/ui/touch-override';
import { buildDrizzleStudioUrl } from '@/lib/utils/routes';
import { SidebarFooter } from './sidebar-footer';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const {
  mockSignOutAndClearCache,
  mockUseSession,
  mockNavigate,
  mockUseStableBalance,
  mockFeatureFlags,
  mockEnv,
  mockPlatform,
  mockOpenExternalPage,
} = vi.hoisted(() => ({
  mockSignOutAndClearCache: vi.fn().mockImplementation(() => Promise.resolve()),
  mockUseSession: vi.fn(),
  mockNavigate: vi.fn(),
  mockUseStableBalance: vi.fn(),
  mockFeatureFlags: {
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
  mockPlatform: { native: false },
  mockOpenExternalPage: vi.fn(),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    FEATURE_FLAGS: mockFeatureFlags,
  };
});

vi.mock('@/lib/auth/auth', () => ({
  signOutAndClearCache: mockSignOutAndClearCache,
  useSession: mockUseSession,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: mockUseStableBalance,
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  }),
}));

vi.mock('@/lib/platform/env', () => ({
  env: mockEnv,
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => mockPlatform.native,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalPage: mockOpenExternalPage,
}));

const originalMatchMedia = globalThis.matchMedia;

/** Narrows the window below 768px, where a menu is a bottom sheet unless it asks otherwise. */
function stubPhoneWidth(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === '(max-width: 767px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

/** The titles of the open menu's items, in order, with each separator as `---`. */
function menuOutline(): string[] {
  const menu = screen.getByRole('menu');
  return [
    ...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="separator"]'),
  ].map((node) => (node.getAttribute('role') === 'separator' ? '---' : node.textContent));
}

const DEV_ITEMS = ['Personas', 'Emails', 'Assets', 'Database Studio', 'Admin', 'Touch Mode'];

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRightPane.setState({ active: null });
    // Both dev-tool URLs are registry-defined in every mode DevOnly renders
    // (Development + local E2E), so a real dev build always has them; stub them
    // here so the dev menu resolves like a real build.
    vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
    vi.stubEnv('VITE_ADMIN_URL', 'http://localhost:7000');
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
    mockUseSession.mockReturnValue({
      data: {
        user: { email: 'test@example.com', username: 'test_user' },
        session: { id: 'session-123' },
      },
    });
    mockUseStableBalance.mockReturnValue({
      displayBalance: '12345678900',
      isStable: true,
    });
    mockPlatform.native = false;
    useUIModalsStore.setState({ feedbackOpen: false });
  });

  describe('expanded state', () => {
    it("renders the account's initial", () => {
      render(<SidebarFooter />);
      expect(
        screen.getByTestId(TEST_IDS.accountButton).querySelector('[data-slot="avatar"]')
      ).toHaveTextContent('T');
    });

    it('renders user username when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    it('renders the credits display when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('$12.34')).toBeInTheDocument();
    });

    it('puts the sign ahead of the currency symbol for a negative balance', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '-500000000',
        isStable: true,
      });
      render(<SidebarFooter />);
      expect(screen.getByText('-$0.50')).toBeInTheDocument();
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
      expect(screen.getByText('$0.00')).toBeInTheDocument();
    });

    it('shows dropdown menu on click', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('shows Settings option in dropdown when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuSettings)).toBeInTheDocument();
    });

    it('shows Add Credits option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuAddCredits)).toBeInTheDocument();
    });

    it('navigates to /billing when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuAddCredits));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/billing' });
    });

    it('shows Send feedback option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuFeedback)).toBeInTheDocument();
    });

    it('opens the feedback dialog through the shared store when Send feedback is chosen', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuFeedback));

      expect(useUIModalsStore.getState().feedbackOpen).toBe(true);
    });

    it('holds no feedback dialog of its own', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuFeedback));

      expect(screen.queryByTestId(TEST_IDS.feedbackModal)).not.toBeInTheDocument();
    });

    it('shows GitHub option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      const githubLink = screen.getByTestId(TEST_IDS.menuGithub);
      expect(githubLink).toBeInTheDocument();
      expect(githubLink).toHaveAttribute('href', 'https://github.com/lome-ai/hushbox');
      expect(githubLink).toHaveAttribute('target', '_blank');
    });

    it('shows About HushBox link in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      const link = screen.getByTestId(TEST_IDS.menuMarketing);
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', ROUTES.MARKETING);
    });

    it('shows Log Out option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuLogout)).toBeInTheDocument();
    });

    it('calls signOutAndClearCache when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuLogout));

      expect(mockSignOutAndClearCache).toHaveBeenCalled();
    });

    it('carries the account button on the trigger', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId(TEST_IDS.accountButton)).toHaveAttribute('aria-haspopup', 'menu');
    });
  });

  describe('beside a docked right pane', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: true });
      useRightPane.setState({ active: 'members' });
    });

    it('draws its rail form while the saved choice is open', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('Test User')).toHaveClass('sr-only');
    });
  });

  describe('collapsed state (rail mode)', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('renders the avatar when collapsed', () => {
      render(<SidebarFooter />);
      expect(
        screen.getByTestId(TEST_IDS.accountButton).querySelector('[data-slot="avatar"]')
      ).not.toBeNull();
    });

    it('renders the username only as visually hidden text when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('Test User')).toHaveClass('sr-only');
    });

    it('does not render credits when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByText('$12.34')).not.toBeInTheDocument();
    });

    it('drops its side padding on the rail, so the button keeps its touch square', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId(TEST_IDS.sidebarFooter)).toHaveClass('px-0');
    });

    it('has justify-center layout when collapsed', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId(TEST_IDS.sidebarFooter);
      expect(footer).toHaveClass('justify-center');
    });

    it('can open dropdown when collapsed', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });
  });

  describe('common styles', () => {
    it('has border at top', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId(TEST_IDS.sidebarFooter);
      expect(footer).toHaveClass('border-t');
    });

    it('uses sidebar border color', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId(TEST_IDS.sidebarFooter);
      expect(footer).toHaveClass('border-sidebar-border');
    });
  });

  describe('dev-only Personas option', () => {
    it('shows Personas option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuPersonas)).toBeInTheDocument();
    });

    it('shows Personas option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuPersonas)).toBeInTheDocument();
    });

    it('navigates to /dev/personas when Personas is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuPersonas));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/personas',
        search: { type: undefined },
      });
    });

    it('shows Database Studio option in dev mode when authenticated', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuDbStudio)).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('shows Database Studio option in dev mode when unauthenticated', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuDbStudio)).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('Database Studio links to Drizzle Studio URL in new tab', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      const studioLink = screen.getByTestId(TEST_IDS.menuDbStudio);
      expect(studioLink).toHaveAttribute('href', buildDrizzleStudioUrl('http://localhost:4983'));
      expect(studioLink.getAttribute('href')).toMatch(/^https:\/\/local\.drizzle\.studio/);
      expect(studioLink).toHaveAttribute('target', '_blank');
      vi.unstubAllEnvs();
    });

    it('fails fast when VITE_DRIZZLE_STUDIO_URL is unset in dev mode', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', '');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      // The item shows on mode (dev), not on presence; a missing required var
      // behind that gate is a config defect, so opening the menu fails fast.
      await expect(user.click(screen.getByTestId(TEST_IDS.accountButton))).rejects.toThrow(
        /VITE_DRIZZLE_STUDIO_URL/
      );
      vi.unstubAllEnvs();
    });

    it('shows Admin option in dev mode when VITE_ADMIN_URL is set', async () => {
      vi.stubEnv('VITE_ADMIN_URL', 'http://localhost:7000');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuAdmin)).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('Admin links to the admin SPA in a new tab', async () => {
      vi.stubEnv('VITE_ADMIN_URL', 'http://localhost:7000');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      const adminLink = screen.getByTestId(TEST_IDS.menuAdmin);
      expect(adminLink).toHaveAttribute('href', 'http://localhost:7000');
      expect(adminLink).toHaveAttribute('target', '_blank');
      expect(adminLink).toHaveAttribute('rel', 'noopener noreferrer');
      vi.unstubAllEnvs();
    });

    it('fails fast when VITE_ADMIN_URL is unset in dev mode', async () => {
      vi.stubEnv('VITE_ADMIN_URL', '');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      // The item shows on mode (dev), not on presence; a missing required var
      // behind that gate is a config defect, so opening the menu fails fast.
      await expect(user.click(screen.getByTestId(TEST_IDS.accountButton))).rejects.toThrow(
        /VITE_ADMIN_URL/
      );
      vi.unstubAllEnvs();
    });

    it('uses env.isLocalDev for conditional rendering', () => {
      // Personas visibility is controlled by env.isLocalDev (not import.meta.env.DEV).
      // isLocalDev = isDev && !isCI, so Personas is hidden in CI but shown locally.
      // The mock sets isLocalDev: true to test the dev-only UI in this test suite.
      expect(mockEnv.isLocalDev).toBe(true);
    });

    it('hides every dev-only tool and reads no dev-tool URL outside local dev', async () => {
      mockEnv.isLocalDev = false;
      const user = userEvent.setup();
      try {
        render(<SidebarFooter />);
        await user.click(screen.getByTestId(TEST_IDS.accountButton));
        expect(screen.queryByTestId(TEST_IDS.menuPersonas)).not.toBeInTheDocument();
        expect(screen.queryByTestId(TEST_IDS.menuDbStudio)).not.toBeInTheDocument();
        expect(screen.queryByTestId(TEST_IDS.menuAdmin)).not.toBeInTheDocument();
      } finally {
        mockEnv.isLocalDev = true;
      }
    });
  });

  describe('dev-only Emails option', () => {
    it('shows Emails option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuEmails)).toBeInTheDocument();
    });

    it('shows Emails option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuEmails)).toBeInTheDocument();
    });

    it('navigates to /dev/emails when Emails is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuEmails));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/emails',
      });
    });
  });

  describe('dev-only Assets option', () => {
    it('shows Assets option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuAssets)).toBeInTheDocument();
    });

    it('shows Assets option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuAssets)).toBeInTheDocument();
    });

    it('navigates to /dev/assets when Assets is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuAssets));

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

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuLogin)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.menuLogout)).not.toBeInTheDocument();
    });

    it('shows Sign Up option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuSignup)).toBeInTheDocument();
    });

    it('does not show Send feedback option for trial users', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.queryByTestId(TEST_IDS.menuFeedback)).not.toBeInTheDocument();
    });

    it('navigates to /login when Log In is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuLogin));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });

    it('navigates to /signup when Sign Up is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuSignup));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/signup' });
    });

    it('does not show Settings option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.queryByTestId(TEST_IDS.menuSettings)).not.toBeInTheDocument();
    });

    it('does not show Add Credits option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.queryByTestId(TEST_IDS.menuAddCredits)).not.toBeInTheDocument();
    });

    it('still shows GitHub option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuGithub)).toBeInTheDocument();
    });

    it('shows About HushBox link', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      const link = screen.getByTestId(TEST_IDS.menuMarketing);
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
      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuSettings));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Usage is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuUsage));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuAddCredits));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuLogout));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Log In is clicked (unauthenticated)', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuLogin));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Sign Up is clicked (unauthenticated)', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuSignup));
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

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.queryByTestId(TEST_IDS.menuSettings)).not.toBeInTheDocument();
    });

    it('shows Settings when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      expect(screen.getByTestId(TEST_IDS.menuSettings)).toBeInTheDocument();
    });

    it('toggles the touch-mode override from the dev menu', async () => {
      useTouchOverrideStore.setState({ override: false });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuTouchMode));

      expect(useTouchOverrideStore.getState().override).toBe(true);
    });

    it('marks the touch-mode item with a check when the override is active', async () => {
      useTouchOverrideStore.setState({ override: true });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(screen.getByTestId(TEST_IDS.menuTouchMode)).toHaveAttribute('aria-checked', 'true');
      act(() => {
        useTouchOverrideStore.setState({ override: false });
      });
    });
  });

  describe('item sets', () => {
    it('keeps the signed-in menu in its order, without Accessibility', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(menuOutline()).toStrictEqual([
        'Settings',
        'Usage',
        'Add Credits',
        '---',
        'Send feedback',
        'GitHub',
        'About HushBox',
        '---',
        'Log Out',
        ...DEV_ITEMS,
      ]);
    });

    it('shows the trial menu in its order, without Accessibility', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(menuOutline()).toStrictEqual([
        'GitHub',
        'About HushBox',
        '---',
        'Log In',
        'Sign Up',
        ...DEV_ITEMS,
      ]);
    });

    it('offers no Accessibility item to a signed-in account', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(
        within(screen.getByRole('menu')).queryByRole('menuitem', { name: /accessibility/i })
      ).not.toBeInTheDocument();
    });

    it('offers no Accessibility item to a trial visitor', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(
        within(screen.getByRole('menu')).queryByRole('menuitem', { name: /accessibility/i })
      ).not.toBeInTheDocument();
    });

    it('draws the trial visitor as Trial User with the person icon', () => {
      mockUseSession.mockReturnValue({ data: null });
      render(<SidebarFooter />);

      const avatar = screen
        .getByTestId(TEST_IDS.accountButton)
        .querySelector('[data-slot="avatar"]');
      expect(avatar?.querySelector('svg.lucide-user')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Trial User' })).toBeInTheDocument();
    });
  });

  describe('below 768px', () => {
    beforeEach(() => {
      stubPhoneWidth();
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: originalMatchMedia,
      });
    });

    it('opens the signed-in menu anchored, not as a sheet', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens the trial menu anchored, not as a sheet', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes the drawer when Send feedback is chosen', async () => {
      useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: true });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuFeedback));

      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });
  });

  describe('About HushBox in the native app', () => {
    it('opens the marketing site through the system browser', async () => {
      mockPlatform.native = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuMarketing));

      expect(mockOpenExternalPage).toHaveBeenCalledWith(ROUTES.MARKETING);
    });

    it('is not a link the web view would follow', async () => {
      mockPlatform.native = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(screen.getByTestId(TEST_IDS.menuMarketing)).not.toHaveAttribute('href');
    });
  });

  describe('menu width', () => {
    it('opens the signed-in menu at least 16rem wide, within the viewport', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(screen.getByRole('menu')).toHaveClass('min-w-[min(16rem,calc(100vw-1rem))]');
    });

    it('opens the trial menu at least 16rem wide, within the viewport', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.accountButton));

      expect(screen.getByRole('menu')).toHaveClass('min-w-[min(16rem,calc(100vw-1rem))]');
    });
  });

  describe('the foot', () => {
    it('holds the account button', () => {
      render(<SidebarFooter />);
      expect(
        within(screen.getByTestId(TEST_IDS.sidebarFooter)).getByTestId(TEST_IDS.accountButton)
      ).toBeInTheDocument();
    });
  });
});
