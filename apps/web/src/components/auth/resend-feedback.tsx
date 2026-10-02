import { TEST_IDS } from '@hushbox/shared';
import type { useResendVerification } from '@/hooks/auth/use-resend-verification';
import type * as React from 'react';

interface ResendFeedbackProps {
  feedback: ReturnType<typeof useResendVerification>['feedback'];
}

/** The line under a resend button that says what the last send came to. */
export function ResendFeedback({
  feedback,
}: Readonly<ResendFeedbackProps>): React.JSX.Element | null {
  if (feedback === null) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`mt-3 text-center text-sm ${feedback.isError ? 'text-destructive' : 'text-success'}`}
      data-testid={TEST_IDS.resendFeedback}
    >
      <span aria-hidden="true">{feedback.isError ? '✗' : '✓'}</span> {feedback.message}
    </p>
  );
}
