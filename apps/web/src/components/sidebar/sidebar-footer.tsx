import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Accessibility,
  Check,
  Database,
  ExternalLink as ExternalLinkIcon,
  Image,
  Mail,
  Smartphone,
  User,
  Settings,
  CreditCard,
  BarChart3,
  LogOut,
  LogIn,
  UserPlus,
  Users,
} from 'lucide-react';
import { SiGithub } from '@icons-pack/react-simple-icons';
import { DropdownMenuItem, DropdownMenuSeparator } from '@hushbox/ui';
import { FEATURE_FLAGS, displayUsername, ROUTES } from '@hushbox/shared';
import { ExternalPageLink } from '@/components/shared/external-page-link';

import { useUIStore } from '@/stores/ui';
import { useTouchOverrideStore } from '@/stores/touch-override';
import { useSession, signOutAndClearCache } from '@/lib/auth';
import { useStableBalance } from '@/hooks/use-stable-balance';
import { buildDrizzleStudioUrl } from '@/lib/routes';
import { formatBalance } from '@/lib/format';
import { DevOnly } from '@/components/shared/dev-only';
import { SidebarFooterBase } from '@/components/shared/sidebar-footer-base';

function GitHubMenuItem(): React.JSX.Element {
  return (
    <DropdownMenuItem asChild data-testid="menu-github">
      <a href="https://github.com/lome-ai/hushbox" target="_blank" rel="noopener noreferrer">
        <SiGithub className="mr-2 h-4 w-4" />
        GitHub
      </a>
    </DropdownMenuItem>
  );
}

function MarketingMenuItem(): React.JSX.Element {
  return (
    <DropdownMenuItem asChild data-testid="menu-marketing">
      <ExternalPageLink path={ROUTES.MARKETING}>
        <ExternalLinkIcon className="mr-2 h-4 w-4" />
        About HushBox
      </ExternalPageLink>
    </DropdownMenuItem>
  );
}

function DevMenuItems({
  navigate,
  closeMobileSidebar,
}: Readonly<{
  navigate: ReturnType<typeof useNavigate>;
  closeMobileSidebar: () => void;
}>): React.JSX.Element {
  const touchOverride = useTouchOverrideStore((state) => state.override);
  const toggleTouch = useTouchOverrideStore((state) => state.toggle);
  const localStudioUrl = import.meta.env['VITE_DRIZZLE_STUDIO_URL'] as string | undefined;

  return (
    <DevOnly>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.DEV_PERSONAS, search: { type: undefined } });
        }}
        data-testid="menu-personas"
      >
        <Users className="mr-2 h-4 w-4" />
        Personas
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.DEV_EMAILS });
        }}
        data-testid="menu-emails"
      >
        <Mail className="mr-2 h-4 w-4" />
        Emails
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.DEV_ASSETS });
        }}
        data-testid="menu-assets"
      >
        <Image className="mr-2 h-4 w-4" />
        Assets
      </DropdownMenuItem>
      {localStudioUrl && (
        <DropdownMenuItem asChild data-testid="menu-db-studio">
          <a href={buildDrizzleStudioUrl(localStudioUrl)} target="_blank" rel="noopener noreferrer">
            <Database className="mr-2 h-4 w-4" />
            Database Studio
          </a>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={(e) => {
          e.preventDefault();
          toggleTouch();
        }}
        data-testid="menu-touch-mode"
      >
        <Smartphone className="mr-2 h-4 w-4" />
        Touch Mode
        {touchOverride === true && <Check className="ml-auto h-4 w-4" />}
      </DropdownMenuItem>
    </DevOnly>
  );
}

interface MenuItemsProps {
  navigate: ReturnType<typeof useNavigate>;
  closeMobileSidebar: () => void;
}

function AccessibilityMenuItem({
  navigate,
  closeMobileSidebar,
}: Readonly<MenuItemsProps>): React.JSX.Element {
  return (
    <DropdownMenuItem
      onClick={() => {
        closeMobileSidebar();
        void navigate({ to: ROUTES.ACCESSIBILITY });
      }}
      data-testid="menu-accessibility"
    >
      <Accessibility className="mr-2 h-4 w-4" />
      Accessibility
    </DropdownMenuItem>
  );
}

function AuthenticatedMenuItems({
  navigate,
  closeMobileSidebar,
}: Readonly<MenuItemsProps>): React.JSX.Element {
  const handleLogout = async (): Promise<void> => {
    await signOutAndClearCache();
    void navigate({ to: ROUTES.LOGIN });
  };

  return (
    <>
      {FEATURE_FLAGS.SETTINGS_ENABLED && (
        <DropdownMenuItem
          onClick={() => {
            closeMobileSidebar();
            void navigate({ to: ROUTES.SETTINGS });
          }}
          data-testid="menu-settings"
        >
          <Settings className="mr-2 h-4 w-4" />
          Settings
        </DropdownMenuItem>
      )}
      <AccessibilityMenuItem navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.USAGE });
        }}
        data-testid="menu-usage"
      >
        <BarChart3 className="mr-2 h-4 w-4" />
        Usage
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.BILLING });
        }}
        data-testid="menu-add-credits"
      >
        <CreditCard className="mr-2 h-4 w-4" />
        Add Credits
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <GitHubMenuItem />
      <MarketingMenuItem />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void handleLogout();
        }}
        data-testid="menu-logout"
      >
        <LogOut className="mr-2 h-4 w-4" />
        Log Out
      </DropdownMenuItem>
      <DevMenuItems navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
    </>
  );
}

function TrialMenuItems({
  navigate,
  closeMobileSidebar,
}: Readonly<MenuItemsProps>): React.JSX.Element {
  return (
    <>
      <AccessibilityMenuItem navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
      <DropdownMenuSeparator />
      <GitHubMenuItem />
      <MarketingMenuItem />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.LOGIN });
        }}
        data-testid="menu-login"
      >
        <LogIn className="mr-2 h-4 w-4" />
        Log In
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.SIGNUP });
        }}
        data-testid="menu-signup"
      >
        <UserPlus className="mr-2 h-4 w-4" />
        Sign Up
      </DropdownMenuItem>
      <DevMenuItems navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
    </>
  );
}

export function SidebarFooter(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);
  const { data: session } = useSession();
  const { displayBalance, isStable } = useStableBalance();
  const navigate = useNavigate();

  const closeMobileSidebar = React.useCallback(() => {
    setMobileSidebarOpen(false);
  }, [setMobileSidebarOpen]);

  const isAuthenticated = !!session?.user;
  const displayName = isAuthenticated ? displayUsername(session.user.username) : 'Trial User';
  let sublabel: string | undefined;
  if (isAuthenticated) {
    sublabel = isStable ? formatBalance(displayBalance) : '$...';
  }

  return (
    <SidebarFooterBase
      icon={<User className="h-4 w-4" data-testid="user-avatar-icon" />}
      label={displayName}
      sublabel={sublabel}
      collapsed={!sidebarOpen}
      testId="sidebar"
      dropdownContent={
        isAuthenticated ? (
          <AuthenticatedMenuItems navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
        ) : (
          <TrialMenuItems navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
        )
      }
    />
  );
}
