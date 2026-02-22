import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { DropdownMenuItem, DropdownMenuSeparator } from '@hushbox/ui';
import { Database, User, Settings, CreditCard, LogOut, LogIn, UserPlus, Users } from 'lucide-react';
import { SiGithub } from '@icons-pack/react-simple-icons';
import { FEATURE_FLAGS, displayUsername, ROUTES } from '@hushbox/shared';

import { useUIStore } from '@/stores/ui';
import { useSession, signOutAndClearCache } from '@/lib/auth';
import { useStableBalance } from '@/hooks/use-stable-balance';
import { DRIZZLE_STUDIO_URL } from '@/lib/routes';
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

function DevMenuItems({
  navigate,
}: Readonly<{ navigate: ReturnType<typeof useNavigate> }>): React.JSX.Element {
  return (
    <DevOnly>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          void navigate({ to: ROUTES.DEV_PERSONAS, search: { type: undefined } });
        }}
        data-testid="menu-personas"
      >
        <Users className="mr-2 h-4 w-4" />
        Personas
      </DropdownMenuItem>
      <DropdownMenuItem asChild data-testid="menu-db-studio">
        <a href={DRIZZLE_STUDIO_URL} target="_blank" rel="noopener noreferrer">
          <Database className="mr-2 h-4 w-4" />
          Database Studio
        </a>
      </DropdownMenuItem>
    </DevOnly>
  );
}

interface MenuItemsProps {
  navigate: ReturnType<typeof useNavigate>;
}

function AuthenticatedMenuItems({ navigate }: Readonly<MenuItemsProps>): React.JSX.Element {
  const handleLogout = async (): Promise<void> => {
    await signOutAndClearCache();
    void navigate({ to: ROUTES.LOGIN });
  };

  return (
    <>
      {FEATURE_FLAGS.SETTINGS_ENABLED && (
        <DropdownMenuItem
          onClick={() => {
            void navigate({ to: ROUTES.SETTINGS });
          }}
          data-testid="menu-settings"
        >
          <Settings className="mr-2 h-4 w-4" />
          Settings
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={() => {
          void navigate({ to: ROUTES.BILLING });
        }}
        data-testid="menu-add-credits"
      >
        <CreditCard className="mr-2 h-4 w-4" />
        Add Credits
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <GitHubMenuItem />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          void handleLogout();
        }}
        data-testid="menu-logout"
      >
        <LogOut className="mr-2 h-4 w-4" />
        Log Out
      </DropdownMenuItem>
      <DevMenuItems navigate={navigate} />
    </>
  );
}

function TrialMenuItems({ navigate }: Readonly<MenuItemsProps>): React.JSX.Element {
  return (
    <>
      <GitHubMenuItem />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          void navigate({ to: ROUTES.LOGIN });
        }}
        data-testid="menu-login"
      >
        <LogIn className="mr-2 h-4 w-4" />
        Log In
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          void navigate({ to: ROUTES.SIGNUP });
        }}
        data-testid="menu-signup"
      >
        <UserPlus className="mr-2 h-4 w-4" />
        Sign Up
      </DropdownMenuItem>
      <DevMenuItems navigate={navigate} />
    </>
  );
}

export function SidebarFooter(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const { data: session } = useSession();
  const { displayBalance, isStable } = useStableBalance();
  const navigate = useNavigate();

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
          <AuthenticatedMenuItems navigate={navigate} />
        ) : (
          <TrialMenuItems navigate={navigate} />
        )
      }
    />
  );
}
