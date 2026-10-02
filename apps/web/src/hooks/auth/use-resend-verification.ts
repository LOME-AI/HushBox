import { useState, useEffect, useCallback, useRef } from 'react';
import { asErrorCode, friendlyErrorMessage } from '@hushbox/shared';
import { authClient } from '@/lib/auth/auth';

const COOLDOWN_SECONDS = 60;

interface ResendFeedback {
  message: string;
  isError: boolean;
}

interface ResendVerification {
  send: () => Promise<void>;
  isSending: boolean;
  cooldown: number;
  feedback: ResendFeedback | null;
}

/** The resend button's text, shared by every surface that offers a resend. */
export function resendButtonLabel(isSending: boolean, cooldown: number): string {
  if (isSending) return 'Sending...';
  if (cooldown > 0) return `Resend verification email (${String(cooldown)}s)`;
  return 'Resend verification email';
}

/**
 * Requests a new verification email for `email`. A sent email and a refusal
 * both start the cooldown; a request that throws starts none, so the visitor
 * can retry at once.
 */
export function useResendVerification(
  email: string,
  options?: { autoResend?: boolean }
): ResendVerification {
  const autoResend = options?.autoResend ?? false;
  const [isSending, setIsSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [feedback, setFeedback] = useState<ResendFeedback | null>(null);
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

  const send = useCallback(async (): Promise<void> => {
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
    } catch (error) {
      setFeedback({ message: friendlyErrorMessage(asErrorCode(error)), isError: true });
    } finally {
      setIsSending(false);
    }
  }, [email]);

  useEffect(() => {
    if (autoResend && !autoResendFired.current) {
      autoResendFired.current = true;
      void send();
    }
  }, [autoResend, send]);

  return { send, isSending, cooldown, feedback };
}
