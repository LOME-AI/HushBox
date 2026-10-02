import * as React from 'react';
import { Button } from '@hushbox/ui/button';
import { useFormFactor } from '@hushbox/ui/platform';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { useOtpVerification } from '@/hooks/auth/use-otp-verification';
import { AuthFormHeader } from '@/components/auth/auth-form-header';
import { OtpInput } from '@/components/auth/otp-input';
import { focusHeading } from '@/lib/focus-heading';
import type { ErrorCode } from '@hushbox/shared';

// The verifier built by `createTOTPVerifier` in `apps/web/src/lib/auth/auth.ts`
// returns a rendered sentence and no code, so this state falls back to matching
// that sentence. Rewording it is safe, because both sides read the one shared
// map entry; the coupling is on the code the verifier picks, and returning a
// different one, wrapping the string, or handing back the code instead would
// turn this comparison false with no compile error. `errorCode` is the
// drift-proof path for whenever the verifier can supply it, and until then this
// seam is pinned only by the end-to-end case in `e2e/auth/auth-2fa.spec.ts`.
const SIGN_IN_COMPLETION_MESSAGE = friendlyErrorMessage('SIGN_IN_COMPLETION_FAILED');

interface TwoFactorVerifyResult {
  success: boolean;
  error?: string;
  errorCode?: ErrorCode;
}

interface TwoFactorLoginStepProps {
  onVerify: (code: string) => Promise<TwoFactorVerifyResult>;
  onSuccess: () => void;
  onBack: () => void;
}

/** The login's second factor, drawn in the auth page in place of the login form. */
export function TwoFactorLoginStep({
  onVerify,
  onSuccess,
  onBack,
}: Readonly<TwoFactorLoginStepProps>): React.JSX.Element {
  const [errorCode, setErrorCode] = React.useState<ErrorCode | undefined>();
  // An accepted code retires the prompt: the page stays until the way to chat has loaded,
  // and a second verify would spend a two-factor attempt on a code the server has used.
  const [accepted, setAccepted] = React.useState(false);
  const codeRef = React.useRef<HTMLInputElement>(null);
  const stepRef = React.useRef<HTMLDivElement>(null);
  // Read once: the step takes focus when it arrives, never on a later resize. A phone
  // keeps its keyboard down until the reader taps the code field.
  const { band } = useFormFactor();
  const [focusOnArrival] = React.useState(band === 'desktop');

  React.useEffect(() => {
    if (focusOnArrival) codeRef.current?.focus();
  }, [focusOnArrival]);

  const verifyAndKeepCode = React.useCallback(
    async (code: string): Promise<TwoFactorVerifyResult> => {
      const result = await onVerify(code);
      setErrorCode(result.errorCode);
      return result;
    },
    [onVerify]
  );

  const acceptAndSucceed = React.useCallback(() => {
    setAccepted(true);
    onSuccess();
  }, [onSuccess]);

  const { otpValue, setOtpValue, error, isVerifying, handleVerify } = useOtpVerification({
    onVerify: verifyAndKeepCode,
    onSuccess: acceptAndSucceed,
  });

  // The sixth digit and Verify send the same thing: the code on screen. The code field
  // calls this from the render in which its value reached six digits, so that render's
  // code is the one sent.
  const verifyCodeOnScreen = React.useCallback(() => {
    handleVerify();
  }, [handleVerify]);

  // The server accepted the code and the session is live, so the code prompt is
  // retired: showing it back would ask the user to spend another two-factor
  // attempt on a step of their sign-in that already succeeded. Reloading resumes
  // that sign-in from the stored key and the live session.
  const isFinishingSignIn =
    errorCode === undefined
      ? error === SIGN_IN_COMPLETION_MESSAGE
      : errorCode === 'SIGN_IN_COMPLETION_FAILED';

  // The code field that held focus is gone, so the new heading takes it and is announced.
  React.useEffect(() => {
    if (isFinishingSignIn) focusHeading(stepRef.current);
  }, [isFinishingSignIn]);

  if (isFinishingSignIn) {
    return (
      <div ref={stepRef} data-testid={TEST_IDS.twoFactorLoginStep}>
        <AuthFormHeader
          title="Finishing sign-in"
          subtitle={SIGN_IN_COMPLETION_MESSAGE}
          titleTone="signal"
          subtitleTone="muted"
        />
        <Button
          type="button"
          size="xl"
          block
          onClick={() => {
            globalThis.location.reload();
          }}
        >
          Reload
        </Button>
      </div>
    );
  }

  return (
    <div data-testid={TEST_IDS.twoFactorLoginStep}>
      <AuthFormHeader
        title="Two-Factor Authentication"
        subtitle={
          // Balanced so a phone never strands the last word on a line of its own.
          <span className="block text-balance">
            Enter the 6-digit code from your authenticator app.
          </span>
        }
        titleTone="signal"
        subtitleTone="muted"
      />

      <div className="flex flex-col gap-2">
        <OtpInput
          appearance="field"
          aria-label="6-digit code"
          ref={codeRef}
          disabled={accepted}
          value={otpValue}
          onChange={setOtpValue}
          onComplete={verifyCodeOnScreen}
          error={error}
        />

        <Button
          type="button"
          size="xl"
          block
          disabled={accepted || otpValue.length !== 6}
          loading={isVerifying}
          loadingLabel="Verifying..."
          onClick={verifyCodeOnScreen}
        >
          Verify
        </Button>

        <p className="mt-2 text-center text-sm">
          <Button type="button" variant="link" onClick={onBack}>
            Back to login
          </Button>
        </p>
      </div>
    </div>
  );
}
