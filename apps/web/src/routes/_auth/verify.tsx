import * as React from 'react';
import { useEffect, useState } from 'react';
import { createFileRoute, useSearch, useNavigate, Link } from '@tanstack/react-router';
import { toast } from '@hushbox/ui';
import { authClient } from '@/lib/auth';
import { ROUTES } from '@hushbox/shared';

type VerifyState = 'loading' | 'success' | 'error';

export const Route = createFileRoute('/_auth/verify')({
  component: VerifyPage,
});

export function VerifyPage(): React.JSX.Element {
  const search = useSearch({ from: '/_auth/verify' });
  const navigate = useNavigate();
  const [state, setState] = useState<VerifyState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const token = (search as { token?: string }).token;

  useEffect(() => {
    if (!token) return;

    // Token is validated above, capture it for the async closure
    const verificationToken = token;

    async function verify(): Promise<void> {
      try {
        const response = await authClient.verifyEmail({
          query: { token: verificationToken },
        });
        if (response.error) {
          setState('error');
          setErrorMessage(response.error.message);
          return;
        }
        setState('success');
        toast.success('Email verified successfully!');
        void navigate({ to: ROUTES.LOGIN });
      } catch {
        setState('error');
        setErrorMessage('Verification failed. Please try again.');
      }
    }

    void verify();
  }, [token, navigate]);

  if (!token) {
    return (
      <div className="text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">No verification token</h1>
        <p className="text-muted">
          The verification link appears to be invalid. Please check your email for the correct link.
        </p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Verification failed</h1>
        <p className="text-muted-foreground mb-4">
          {errorMessage || 'This verification link has expired.'}
        </p>
        <p className="text-muted-foreground mb-6 text-sm">
          Log in to receive a new verification email.
        </p>
        <Link to={ROUTES.LOGIN} className="text-primary font-medium hover:underline">
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-foreground mb-2 text-3xl font-bold">Verifying your email</h1>
      <p className="text-muted mb-8">Please wait while we verify your email address...</p>
      <div className="flex justify-center">
        <div className="border-primary h-8 w-8 animate-spin rounded-full border-4 border-t-transparent" />
      </div>
    </div>
  );
}
