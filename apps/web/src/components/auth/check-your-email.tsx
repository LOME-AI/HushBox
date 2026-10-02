import { Mail } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { Button } from '@hushbox/ui/button';
import { AuthFormHeader } from '@/components/auth/auth-form-header';
import { ResendFeedback } from '@/components/auth/resend-feedback';
import { resendButtonLabel, useResendVerification } from '@/hooks/auth/use-resend-verification';
import type * as React from 'react';

interface CheckYourEmailProps {
  email: string;
  autoResend?: boolean;
}

export function CheckYourEmail({
  email,
  autoResend = false,
}: Readonly<CheckYourEmailProps>): React.JSX.Element {
  const { send, isSending, cooldown, feedback } = useResendVerification(email, { autoResend });

  return (
    <div className="text-center" data-testid={TEST_IDS.checkYourEmail}>
      <Mail className="text-muted-foreground mx-auto mb-4 h-12 w-12" />
      <div className="mb-6">
        <AuthFormHeader
          title="Check your email"
          subtitle={
            <>
              We&apos;ve sent a verification link to{' '}
              <span className="text-foreground font-medium">{email}</span>. Click the link to verify
              your account.
            </>
          }
          subtitleTone="text"
        />
      </div>

      <Button
        type="button"
        size="xl"
        block
        disabled={isSending || cooldown > 0}
        onClick={() => {
          void send();
        }}
        data-testid={TEST_IDS.resendButton}
      >
        {resendButtonLabel(isSending, cooldown)}
      </Button>

      <ResendFeedback feedback={feedback} />

      <p className="text-muted-foreground mt-4 text-xs">
        Didn&apos;t receive it? Check your spam folder.
      </p>
    </div>
  );
}
