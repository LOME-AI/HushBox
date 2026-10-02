import * as React from 'react';
import { createFileRoute, redirect, Link, Outlet } from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { LAYOUT } from '@hushbox/shared/design-tokens';
import { CipherWall, Logo, ReleaseStageBadge } from '@hushbox/ui';
import { ExternalPageLink } from '@/components/shared/external-page-link';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { authClient } from '@/lib/auth/auth';

const AUTH_CIPHER_MESSAGES: readonly string[] = [
  'Encrypted By Default',
  'Only You Hold The Key',
  'Every Model, One Place',
  'Private Group Chats',
  'Zero-Knowledge Password',
  'Switch Models Anytime',
  'Your Messages, Your Control',
  'No Subscriptions Required',
  'One App, Every AI',
  'Never Lose A Conversation',
  'Stop Juggling Subscriptions',
  'Try Any Model Instantly',
  'Your Ideas Stay Yours',
  'Simple, Honest Pricing',
  'No More App Switching',
  'Built For Your Workflow',
];

// Beside the wall the form column keeps its minimum; where the wall is hidden the column is
// the frame's whole width, so the minimum never pushes it past a narrow screen.
const FORM_COLUMN_STYLE: React.CSSProperties = {
  minWidth: `min(100%, ${LAYOUT.authWall.formMin})`,
};

export const Route = createFileRoute('/_auth')({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (session.data) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: ROUTES.CHAT });
    }
  },
  component: AuthLayout,
});

function AuthLayout(): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.authLayout}
      className="bg-background @container/auth flex min-h-full"
    >
      {/* The head's padding is the corner row's room. Beside the wall the foot keeps the same
          room, so a page that fits stays centred on the column and a taller one scrolls
          rather than rising into the row. */}
      <div
        className="@min-auth-wall/auth:px-16 @min-auth-wall/auth:pb-14 relative flex flex-1 flex-col justify-center px-8 pt-14 pb-8 pointer-coarse:px-8 pointer-coarse:pb-8"
        style={FORM_COLUMN_STYLE}
      >
        {/* One row holds both corners so they reserve room from each other; where the
            badge no longer fits beside the logo it wraps beneath it, clear of the toggle. */}
        <div className="absolute inset-x-4 top-4 flex items-start justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {/* Stacked over the badge: when the badge wraps beneath the logo, its enlarged
                touch area reaches up over the mark, and a tap there must still go to chat. */}
            <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat" className="relative z-10">
              <Logo />
            </Link>
            <ReleaseStageBadge
              link={({ href, ...props }) => <ExternalPageLink path={href} {...props} />}
            />
          </div>
          <div className="shrink-0">
            <ThemeToggle />
          </div>
        </div>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md">
          <div className="mb-6 flex justify-center" />
          <Outlet />
        </main>
      </div>

      <div className="@min-auth-wall/auth:block hidden flex-1 overflow-hidden pointer-coarse:hidden">
        <CipherWall messages={AUTH_CIPHER_MESSAGES} />
      </div>
    </div>
  );
}
