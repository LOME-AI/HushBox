import * as React from 'react';
import { cn } from '@hushbox/ui';
import { Menu, MenuItem, MenuSeparator } from '@hushbox/ui/menu';
import {
  BarChart3,
  CreditCard,
  Database,
  ExternalLink,
  GitHubMark,
  Image,
  LogIn,
  LogOut,
  Mail,
  MessageSquarePlus,
  Settings,
  Shield,
  Smartphone,
  UserPlus,
  Users,
} from '@hushbox/ui/icons';
import { FEATURE_FLAGS, displayUsername, ROUTES, TEST_IDS } from '@hushbox/shared';
import { useSidebarRail } from '@/hooks/ui/use-sidebar-rail';
import { useAppActionContext } from '@/hooks/ui/use-app-action-context';
import { useTouchOverrideStore } from '@/stores/ui/touch-override';
import { useSession, signOutAndClearCache } from '@/lib/auth/auth';
import { APP_ACTIONS, type AppActionContext } from '@/lib/app-actions';
import { useStableBalance } from '@/hooks/billing/use-stable-balance';
import { buildDrizzleStudioUrl } from '@/lib/utils/routes';
import { formatBalance } from '@/lib/billing/format';
import { isNative } from '@/capacitor/platform';
import { openExternalPage } from '@/capacitor/browser';
import { DevOnly } from '@/components/shared/dev-only';
import { env } from '@/lib/platform/env';
import { AccountButton } from './account-button';

const GITHUB_URL = 'https://github.com/lome-ai/hushbox';

// signOutAndClearCache() hard-reloads the page. Where that lands is the route's
// own business: a requireAuth-guarded route redirects the cleared session to
// /login, and an unguarded one (the chat index) stays put as a trial page. No
// client navigate follows — it would never run before the reload.
async function logout(): Promise<void> {
  await signOutAndClearCache();
}

// Reads a dev-tool origin the env registry defines for every mode DevOnly
// renders (Development + local E2E). A missing value behind that mode gate is a
// config defect, so this fails fast rather than emitting an `undefined/…` href.
function devToolUrl(key: 'VITE_DRIZZLE_STUDIO_URL' | 'VITE_ADMIN_URL'): string {
  const url = import.meta.env[key] as string | undefined;
  if (url === undefined || url === '') {
    throw new Error(`${key} must be defined when the dev server runs`);
  }
  return url;
}

function GitHubMenuItem(): React.JSX.Element {
  return (
    <MenuItem
      icon={GitHubMark}
      title="GitHub"
      href={GITHUB_URL}
      external
      data-testid={TEST_IDS.menuGithub}
    />
  );
}

// The native shell's web view would open a relative marketing path inside the app, so
// there the item hands the page to the system browser instead of being a link.
function MarketingMenuItem(): React.JSX.Element {
  return isNative() ? (
    <MenuItem
      icon={ExternalLink}
      title="About HushBox"
      onSelect={() => {
        void openExternalPage(ROUTES.MARKETING);
      }}
      data-testid={TEST_IDS.menuMarketing}
    />
  ) : (
    <MenuItem
      icon={ExternalLink}
      title="About HushBox"
      href={ROUTES.MARKETING}
      external
      data-testid={TEST_IDS.menuMarketing}
    />
  );
}

interface MenuItemsProps {
  context: AppActionContext;
}

function DevMenuItems({ context }: Readonly<MenuItemsProps>): React.JSX.Element {
  const touchOverride = useTouchOverrideStore((state) => state.override);
  const toggleTouch = useTouchOverrideStore((state) => state.toggle);
  const { navigate, closeDrawer } = context;

  return (
    <DevOnly>
      <MenuItem
        icon={Users}
        title="Personas"
        onSelect={() => {
          closeDrawer();
          void navigate({ to: ROUTES.DEV_PERSONAS, search: { type: undefined } });
        }}
        data-testid={TEST_IDS.menuPersonas}
      />
      <MenuItem
        icon={Mail}
        title="Emails"
        onSelect={() => {
          closeDrawer();
          void navigate({ to: ROUTES.DEV_EMAILS });
        }}
        data-testid={TEST_IDS.menuEmails}
      />
      <MenuItem
        icon={Image}
        title="Assets"
        onSelect={() => {
          closeDrawer();
          void navigate({ to: ROUTES.DEV_ASSETS });
        }}
        data-testid={TEST_IDS.menuAssets}
      />
      {/* Branch on mode, not on the vars' presence: the `&&` short-circuits so
          the URL reads never run outside local dev, and behind that mode gate
          the registry guarantees the values (devToolUrl fails fast otherwise). */}
      {env.isLocalDev && (
        <MenuItem
          icon={Database}
          title="Database Studio"
          href={buildDrizzleStudioUrl(devToolUrl('VITE_DRIZZLE_STUDIO_URL'))}
          external
          data-testid={TEST_IDS.menuDbStudio}
        />
      )}
      {env.isLocalDev && (
        <MenuItem
          icon={Shield}
          title="Admin"
          href={devToolUrl('VITE_ADMIN_URL')}
          external
          data-testid={TEST_IDS.menuAdmin}
        />
      )}
      <MenuItem
        icon={Smartphone}
        title="Touch Mode"
        checked={touchOverride === true}
        onSelect={toggleTouch}
        data-testid={TEST_IDS.menuTouchMode}
      />
    </DevOnly>
  );
}

function AuthenticatedMenuItems({ context }: Readonly<MenuItemsProps>): React.JSX.Element {
  return (
    <>
      {FEATURE_FLAGS.SETTINGS_ENABLED && (
        <MenuItem
          icon={Settings}
          title="Settings"
          onSelect={() => {
            APP_ACTIONS.settings.run(context);
          }}
          data-testid={TEST_IDS.menuSettings}
        />
      )}
      <MenuItem
        icon={BarChart3}
        title="Usage"
        onSelect={() => {
          APP_ACTIONS.usage.run(context);
        }}
        data-testid={TEST_IDS.menuUsage}
      />
      <MenuItem
        icon={CreditCard}
        title="Add Credits"
        onSelect={() => {
          APP_ACTIONS.addCredit.run(context);
        }}
        data-testid={TEST_IDS.menuAddCredits}
      />
      <MenuSeparator />
      <MenuItem
        icon={MessageSquarePlus}
        title="Send feedback"
        onSelect={() => {
          APP_ACTIONS.sendFeedback.run(context);
        }}
        data-testid={TEST_IDS.menuFeedback}
      />
      <GitHubMenuItem />
      <MarketingMenuItem />
      <MenuSeparator />
      <MenuItem
        icon={LogOut}
        title="Log Out"
        onSelect={() => {
          context.closeDrawer();
          void logout();
        }}
        data-testid={TEST_IDS.menuLogout}
      />
      <DevMenuItems context={context} />
    </>
  );
}

function TrialMenuItems({ context }: Readonly<MenuItemsProps>): React.JSX.Element {
  const { navigate, closeDrawer } = context;
  return (
    <>
      <GitHubMenuItem />
      <MarketingMenuItem />
      <MenuSeparator />
      <MenuItem
        icon={LogIn}
        title="Log In"
        onSelect={() => {
          closeDrawer();
          void navigate({ to: ROUTES.LOGIN });
        }}
        data-testid={TEST_IDS.menuLogin}
      />
      <MenuItem
        icon={UserPlus}
        title="Sign Up"
        onSelect={() => {
          closeDrawer();
          void navigate({ to: ROUTES.SIGNUP });
        }}
        data-testid={TEST_IDS.menuSignup}
      />
      <DevMenuItems context={context} />
    </>
  );
}

export function SidebarFooter(): React.JSX.Element {
  const { data: session } = useSession();
  const { displayBalance, isStable } = useStableBalance();
  const collapsed = useSidebarRail();
  const context = useAppActionContext();

  const account =
    session?.user === undefined
      ? null
      : {
          name: displayUsername(session.user.username),
          balance: isStable ? formatBalance(displayBalance) : '$...',
        };

  return (
    <div
      data-testid={TEST_IDS.sidebarFooter}
      className={cn('border-sidebar-border border-t p-2', collapsed && 'flex justify-center px-0')}
    >
      <Menu
        title="Account"
        side="top"
        align="start"
        phonePresentation="anchored"
        minWidth="16rem"
        trigger={<AccountButton account={account} collapsed={collapsed} />}
      >
        {account === null ? (
          <TrialMenuItems context={context} />
        ) : (
          <AuthenticatedMenuItems context={context} />
        )}
      </Menu>
    </div>
  );
}
