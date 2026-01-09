import * as React from 'react';
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { authClient } from '@/lib/auth';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { Logo } from '@/components/shared/logo';

export const Route = createFileRoute('/_auth')({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (session.data) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
      throw redirect({ to: '/chat' });
    }
  },
  component: AuthLayout,
});

export function AuthLayout(): React.JSX.Element {
  return (
    <div data-testid="auth-layout" className="bg-background flex min-h-screen">
      <div className="relative flex flex-1 flex-col justify-center px-8 pt-20 pb-8 lg:px-16 lg:pt-0 lg:pb-0">
        <div className="absolute top-4 left-4">
          <Logo asLink to="/chat" />
        </div>
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 flex justify-center">
            <img src="/assets/images/FlowerBoxHD.png" alt="" className="h-24 w-auto" />
          </div>
          <Outlet />
        </div>
      </div>

      <div className="hidden overflow-hidden lg:block lg:flex-1">
        <img
          src="/assets/images/BackgroundHD.png"
          alt=""
          className="h-full w-full object-cover"
          style={{
            transform: 'scaleX(-1)',
            maskImage: 'linear-gradient(to right, black 50%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 50%, transparent 100%)',
          }}
        />
      </div>
    </div>
  );
}
