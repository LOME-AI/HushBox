import * as React from 'react';
import { Link, Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { Logo } from '@hushbox/ui';
import { ROUTES } from '@hushbox/shared';
import { authClient } from '@/lib/auth';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { CipherWall } from '@/components/auth/cipher-wall';

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

export function AuthLayout(): React.JSX.Element {
  return (
    <div data-testid="auth-layout" className="bg-background flex min-h-dvh">
      <div className="relative flex flex-1 flex-col justify-center px-8 pt-14 pb-8 lg:px-16 lg:pt-0 lg:pb-0">
        <div className="absolute top-4 left-4">
          <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat">
            <Logo />
          </Link>
        </div>
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 flex justify-center" />
          <Outlet />
        </div>
      </div>

      <div className="hidden overflow-hidden lg:block lg:flex-1">
        <CipherWall />
      </div>
    </div>
  );
}
