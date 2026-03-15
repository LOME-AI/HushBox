import * as React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Mail } from 'lucide-react';
import { authClient } from '@/lib/auth';
import { AuthButton } from '@/components/auth/AuthButton';

const COOLDOWN_SECONDS = 60;

interface CheckYourEmailProps {
  email: string;
  autoResend?: boolean;
}

export function CheckYourEmail({
  email,
  autoResend = false,
}: Readonly<CheckYourEmailProps>): React.JSX.Element {
  const [isSending, setIsSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [feedback, setFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const autoResendFired = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((previous) => previous - 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [cooldown]);

  const handleResend = useCallback(async (): Promise<void> => {
    setIsSending(true);
    setFeedback(null);
    try {
      const result = await authClient.resendVerification({ email });
      if (result.error) {
        setFeedback({ message: result.error.message, isError: true });
        setCooldown(COOLDOWN_SECONDS);
      } else {
        setFeedback({ message: 'Verification email sent.', isError: false });
        setCooldown(COOLDOWN_SECONDS);
      }
    } catch {
      setFeedback({ message: 'Something went wrong. Please try again.', isError: true });
    } finally {
      setIsSending(false);
    }
  }, [email]);

  useEffect(() => {
    if (autoResend && !autoResendFired.current) {
      autoResendFired.current = true;
      void handleResend();
    }
  }, [autoResend, handleResend]);

  const isDisabled = isSending || cooldown > 0;

  let buttonText = 'Resend verification email';
  if (isSending) {
    buttonText = 'Sending...';
  } else if (cooldown > 0) {
    buttonText = `Resend verification email (${String(cooldown)}s)`;
  }

  return (
    <div className="text-center" data-testid="check-your-email">
      <Mail className="text-muted-foreground mx-auto mb-4 h-12 w-12" />
      <h1 className="text-foreground mb-2 text-3xl font-bold">Check your email</h1>
      <p className="text-muted-foreground mb-6">
        We&apos;ve sent a verification link to{' '}
        <span className="text-foreground font-medium">{email}</span>. Click the link to verify your
        account.
      </p>

      <AuthButton
        type="button"
        className="w-full"
        disabled={isDisabled}
        onClick={() => {
          void handleResend();
        }}
        data-testid="resend-button"
      >
        {buttonText}
      </AuthButton>

      {feedback && (
        <p
          className={`mt-3 text-sm ${feedback.isError ? 'text-destructive' : 'text-success'}`}
          data-testid="resend-feedback"
        >
          {feedback.isError ? '✗' : '✓'} {feedback.message}
        </p>
      )}

      <p className="text-muted-foreground mt-4 text-xs">
        Didn&apos;t receive it? Check your spam folder.
      </p>
    </div>
  );
}
