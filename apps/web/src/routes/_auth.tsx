import * as React from 'react';
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { authClient } from '@/lib/auth';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { Logo } from '@/components/shared/logo';

export const Route = createFileRoute('/_auth')({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (session.data) {
      // TanStack Router redirect is designed to be thrown
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/chat' });
    }
  },
  component: AuthLayout,
});

export function AuthLayout(): React.JSX.Element {
  return (
    <div data-testid="auth-layout" className="bg-background flex min-h-screen">
      {/* Left: Form area */}
      <div className="relative flex flex-1 flex-col justify-center px-8 lg:px-16">
        {/* Logo in top-left corner - navigates to /chat */}
        <div className="absolute top-4 left-4">
          <Logo asLink to="/chat" />
        </div>
        {/* Theme toggle in top-right corner */}
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="mx-auto w-full max-w-md">
          {/* Decorative FlowerBox image above form */}
          <div className="mb-6 flex justify-center">
            <img src="/assets/images/FlowerBoxHD.png" alt="" className="h-24 w-auto" />
          </div>
          <Outlet />
        </div>
      </div>

      {/* Right: BackgroundHD with fade effect (hidden on mobile) */}
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
