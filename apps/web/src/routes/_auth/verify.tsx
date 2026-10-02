import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createFileRoute, useSearch, Link } from '@tanstack/react-router';
import { useMutationState } from '@tanstack/react-query';
import { toast } from '@hushbox/ui';
import { Button, Spinner } from '@hushbox/ui/button';
import { TextField } from '@hushbox/ui/field';
import { Mail } from '@hushbox/ui/icons';
import { ROUTES, TEST_IDS, asErrorCode, friendlyErrorMessage } from '@hushbox/shared';
import { AuthFormHeader } from '@/components/auth/auth-form-header';
import { ResendFeedback } from '@/components/auth/resend-feedback';
import { resendButtonLabel, useResendVerification } from '@/hooks/auth/use-resend-verification';
import { useVerifyEmail, verifyEmailKeys } from '@/hooks/auth/use-verify-email';
import { ApiError, getErrorBody } from '@/lib/api/api';
import { validateEmail } from '@/lib/auth/validation';

export const Route = createFileRoute('/_auth/verify')({
  component: VerifyPage,
});

/**
 * A refusal reads as the code the server sent. A failure with no readable
 * answer (a dropped connection, a gateway page) reads as the verification's own
 * failure, since nothing says the link itself is at fault.
 */
function verificationFailureMessage(error: Error | null): string {
  if (!(error instanceof ApiError) || error.data === undefined) {
    return friendlyErrorMessage('EMAIL_VERIFICATION_FAILED');
  }
  return friendlyErrorMessage(asErrorCode(getErrorBody(error)?.code));
}

function announceVerified(): void {
  toast.success('Email verified successfully!');
}

/** With no token to verify, the visitor asks for a new link to an address they give. */
function MissingTokenPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [sendTried, setSendTried] = useState(false);
  const { send, isSending, cooldown, feedback } = useResendVerification(email);
  const emailError = sendTried ? validateEmail(email).error : undefined;

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setSendTried(true);
    if (!validateEmail(email).isValid) return;
    void send();
  }

  return (
    <div>
      <div className="mb-6">
        <AuthFormHeader
          title="No verification token"
          subtitle="The verification link appears to be invalid. Please check your email for the correct link."
          subtitleTone="text"
        />
      </div>

      <form onSubmit={handleSubmit} className="space-y-2" noValidate>
        <TextField
          id="email"
          label="Email"
          type="email"
          icon={Mail}
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          {...(emailError === undefined ? {} : { error: emailError })}
        />

        <Button
          type="submit"
          size="xl"
          block
          disabled={isSending || cooldown > 0}
          data-testid={TEST_IDS.resendButton}
        >
          {resendButtonLabel(isSending, cooldown)}
        </Button>
      </form>

      <ResendFeedback feedback={feedback} />
    </div>
  );
}

function VerifyPage(): React.JSX.Element {
  const search = useSearch({ from: '/_auth/verify' });
  const { mutate } = useVerifyEmail(announceVerified);
  const sentForTokenRef = useRef<string | null>(null);

  const token = (search as { token?: string }).token;

  // Read from the mutation cache, not from the `useMutation` result: StrictMode's
  // effect cleanup detaches that observer from the mutation already sent, and
  // the once-per-token guard (`sentForTokenRef`) stops the re-run from sending another.
  const verification = useMutationState({
    filters: {
      mutationKey: verifyEmailKeys.all,
      predicate: (mutation) => mutation.state.variables === token,
    },
    select: (mutation) => mutation.state,
  }).at(-1);

  useEffect(() => {
    if (!token) return;
    if (sentForTokenRef.current === token) return;
    sentForTokenRef.current = token;

    mutate(token);
  }, [token, mutate]);

  if (!token) {
    return <MissingTokenPage />;
  }

  if (verification?.status === 'success') {
    return (
      <div className="text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Email verified</h1>
        <p className="text-muted-foreground mb-6">Your email has been verified successfully.</p>
        <Link to={ROUTES.LOGIN} className="text-primary font-medium hover:underline">
          Continue to login
        </Link>
      </div>
    );
  }

  if (verification?.status === 'error') {
    return (
      <div className="text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Verification failed</h1>
        <p className="text-muted-foreground mb-4">
          {verificationFailureMessage(verification.error)}
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
      <p className="text-muted-foreground mb-8">
        Please wait while we verify your email address...
      </p>
      <div className="flex justify-center">
        <Spinner className="text-primary size-8 border-4" />
      </div>
    </div>
  );
}
