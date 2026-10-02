import * as React from 'react';
import { useState, useRef, useCallback, useEffect } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PRODUCT_TAGLINE, ROUTES } from '@hushbox/shared';
import { InlineFormError } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { CheckField } from '@hushbox/ui/field';
import { useFormFactor } from '@hushbox/ui/platform';
import {
  signIn,
  resetPasswordViaRecovery,
  verifyRecoveryPhrase,
  discardVerifiedRecoveryPhrase,
} from '@/lib/auth/auth';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { IdentifierInput } from '@/components/auth/identifier-input';
import { AuthFormHeader } from '@/components/auth/auth-form-header';
import { PasswordField, ConfirmPasswordField } from '@/components/auth/password-field';
import { TwoFactorLoginStep } from '@/components/auth/two-factor-login-step';
import { AuthFeatureList } from '@/components/auth/auth-feature-list';
import { CheckYourEmail } from '@/components/auth/check-your-email';
import { focusHeading } from '@/lib/focus-heading';
import {
  validateIdentifier,
  validatePassword,
  validateConfirmPassword,
  validateRecoveryPhrase,
} from '@/lib/auth/validation';
import type { VerifiedRecoveryPhrase } from '@/lib/auth/auth';

export const Route = createFileRoute('/_auth/login')({
  component: LoginPage,
});

const PHRASE_FEEDBACK_ID = 'recovery-phrase-feedback';

type Mode =
  | 'login'
  | 'recovery-phrase'
  | 'recovery-new-password'
  | 'recovery-success'
  | 'email-not-verified';

interface IdentifierFieldProps {
  identifier: string;
  setIdentifier: (value: string) => void;
  touched: boolean;
  markTouched: () => void;
}

function IdentifierField({
  identifier,
  setIdentifier,
  touched,
  markTouched,
}: Readonly<IdentifierFieldProps>): React.JSX.Element {
  const validation = touched ? validateIdentifier(identifier) : { isValid: false };
  return (
    <IdentifierInput
      id="identifier"
      value={identifier}
      onChange={(e) => {
        setIdentifier(e.target.value);
        if (!touched) markTouched();
      }}
      aria-invalid={!!validation.error}
      error={validation.error}
      success={validation.success}
    />
  );
}

/** Carries the id the phrase textarea's `aria-describedby` points at. */
function RecoveryPhraseFeedback({
  error,
  success,
}: Readonly<{ error: string | null; success: string | undefined }>): React.JSX.Element {
  return (
    <div id={PHRASE_FEEDBACK_ID}>
      {error && (
        <p role="alert" className="text-destructive mt-1 text-sm">
          {error}
        </p>
      )}
      {!error && success && <p className="text-success mt-1 text-sm">{success}</p>}
    </div>
  );
}

interface RecoveryPhraseFormProps {
  identifier: string;
  setIdentifier: (identifier: string) => void;
  recoveryPhrase: string;
  setRecoveryPhrase: (phrase: string) => void;
  verificationError: string | null;
  clearVerificationError: () => void;
  isVerifying: boolean;
  onNext: () => Promise<void>;
  onBackToLogin: () => void;
}

function RecoveryPhraseForm({
  identifier,
  setIdentifier,
  recoveryPhrase,
  setRecoveryPhrase,
  verificationError,
  clearVerificationError,
  isVerifying,
  onNext,
  onBackToLogin,
}: Readonly<RecoveryPhraseFormProps>): React.JSX.Element {
  const [touched, setTouched] = useState({ identifier: false, recoveryPhrase: false });
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);

  const phraseValidation = touched.recoveryPhrase
    ? validateRecoveryPhrase(recoveryPhrase)
    : { isValid: false };
  // The phrase's own shape first, then the answer from trying it on the account.
  const phraseError = phraseValidation.error ?? verificationError;
  const showsPhraseFeedback =
    touched.recoveryPhrase && Boolean(phraseError ?? phraseValidation.success);

  async function handleNext(): Promise<void> {
    setTouched({ identifier: true, recoveryPhrase: true });

    const iv = validateIdentifier(identifier);
    const pv = validateRecoveryPhrase(recoveryPhrase);

    if (!iv.isValid || !pv.isValid) {
      return;
    }

    await onNext();
  }

  return (
    <div>
      <AuthFormHeader
        title="Reset Password"
        subtitle="Enter your email or username and 12-word recovery phrase"
        subtitleTone="instruction"
      />

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          void handleNext();
        }}
        className="space-y-2"
        noValidate
      >
        <IdentifierField
          identifier={identifier}
          setIdentifier={(value) => {
            clearVerificationError();
            setIdentifier(value);
          }}
          touched={touched.identifier}
          markTouched={() => {
            setTouched((t) => ({ ...t, identifier: true }));
          }}
        />

        <div>
          <label
            htmlFor="recovery-phrase"
            className="text-foreground mb-2 block text-sm font-medium"
          >
            Recovery Phrase
          </label>
          <textarea
            id="recovery-phrase"
            placeholder="Enter your 12-word recovery phrase"
            value={recoveryPhrase}
            onChange={(e) => {
              clearVerificationError();
              setRecoveryPhrase(e.target.value);
              if (!touched.recoveryPhrase) setTouched((t) => ({ ...t, recoveryPhrase: true }));
            }}
            aria-invalid={
              // Announced invalid only while the message explaining it is rendered:
              // the attribute and the feedback must not be able to detach.
              showsPhraseFeedback && !!phraseError
            }
            aria-describedby={showsPhraseFeedback ? PHRASE_FEEDBACK_ID : undefined}
            className="bg-background border-border focus:border-primary focus:ring-primary min-h-[100px] w-full rounded-lg border px-4 py-3 text-sm focus:ring-2 focus:outline-hidden"
          />
          {showsPhraseFeedback && (
            <RecoveryPhraseFeedback error={phraseError} success={phraseValidation.success} />
          )}
        </div>

        <Button
          type="button"
          size="xl"
          block
          disabled={isVerifying}
          onClick={() => {
            void handleNext();
          }}
        >
          {isVerifying ? 'Checking...' : 'Next'}
        </Button>

        <p className="text-muted-foreground mt-2 text-center text-sm">
          Remember your password?{' '}
          <button
            type="button"
            className="text-primary cursor-pointer hover:underline"
            onClick={() => {
              onBackToLogin();
            }}
          >
            Back to login
          </button>
        </p>
      </form>
    </div>
  );
}

interface RecoveryNewPasswordFormProps {
  newPassword: string;
  setNewPassword: (password: string) => void;
  confirmPassword: string;
  setConfirmPassword: (password: string) => void;
  error: string | null;
  errorKey: number;
  isLoading: boolean;
  onResetPassword: () => Promise<void>;
  onBackToRecovery: () => void;
}

function RecoveryNewPasswordForm({
  newPassword,
  setNewPassword,
  confirmPassword,
  setConfirmPassword,
  error,
  errorKey,
  isLoading,
  onResetPassword,
  onBackToRecovery,
}: Readonly<RecoveryNewPasswordFormProps>): React.JSX.Element {
  const [touched, setTouched] = useState({ newPassword: false, confirmPassword: false });
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);

  async function handleSubmit(): Promise<void> {
    setTouched({ newPassword: true, confirmPassword: true });

    const pv = validatePassword(newPassword);
    const cpv = validateConfirmPassword(newPassword, confirmPassword);

    if (!pv.isValid || !cpv.isValid) {
      return;
    }

    await onResetPassword();
  }

  return (
    <div>
      <AuthFormHeader
        title="Create New Password"
        subtitle="Enter your new password"
        subtitleTone="instruction"
      />

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        className="space-y-2"
        noValidate
      >
        <PasswordField
          id="new-password"
          label="New Password"
          password={newPassword}
          setPassword={setNewPassword}
          touched={touched.newPassword}
          markTouched={() => {
            setTouched((t) => ({ ...t, newPassword: true }));
          }}
          showStrength
        />

        <ConfirmPasswordField
          id="confirm-password"
          label="Confirm Password"
          newPassword={newPassword}
          confirmPassword={confirmPassword}
          setConfirmPassword={setConfirmPassword}
          touched={touched.confirmPassword}
          markTouched={() => {
            setTouched((t) => ({ ...t, confirmPassword: true }));
          }}
        />

        <InlineFormError error={error} errorKey={errorKey} />

        <Button
          type="button"
          size="xl"
          block
          onClick={() => {
            void handleSubmit();
          }}
          disabled={isLoading}
        >
          {isLoading ? 'Resetting...' : 'Reset Password'}
        </Button>

        <p className="text-muted-foreground mt-2 text-center text-sm">
          Go back?{' '}
          <button
            type="button"
            className="text-primary cursor-pointer hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            // Leaving mid-reset zeroes the key material the running reset reads.
            disabled={isLoading}
            onClick={() => {
              onBackToRecovery();
            }}
          >
            Back to recovery
          </button>
        </p>
      </form>
    </div>
  );
}

interface RecoverySuccessViewProps {
  onReturnToLogin: () => void;
}

function RecoverySuccessView({
  onReturnToLogin,
}: Readonly<RecoverySuccessViewProps>): React.JSX.Element {
  return (
    <div>
      <AuthFormHeader
        title="Password Reset Successful"
        subtitle="Your password has been successfully reset. You can now log in with your new password."
        subtitleTone="muted"
      />

      <Button type="button" size="xl" block onClick={onReturnToLogin}>
        Return to Login
      </Button>
    </div>
  );
}

function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState({ identifier: false, password: false });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [verified, setVerified] = useState<VerifiedRecoveryPhrase | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  // Set while the sign-in waits on its second factor; the step replaces the form.
  const [verifyTOTP, setVerifyTOTP] = useState<
    ((code: string) => Promise<{ success: boolean; error?: string }>) | null
  >(null);
  const loginFormRef = useRef<HTMLFormElement>(null);
  const loginViewRef = useRef<HTMLDivElement>(null);
  // Where focus lands once the form replaces the two-factor step, whose control held it.
  const landingAfterStepRef = useRef<'password' | 'heading' | null>(null);
  const { band } = useFormFactor();
  useFormEnterNav(loginFormRef);
  // Refs, not the loading flags: Enter reaches the form through requestSubmit
  // whichever button is disabled, and a second submit in the same tick reads a
  // state flag that has not been applied yet.
  const verifyInFlightRef = useRef(false);
  const resetInFlightRef = useRef(false);
  // Bumped on every exit from the reset flow. A verification that resolves after
  // the user left must not pull them back into it, and the same read must not go
  // through state, which the resolve can observe one render stale.
  const recoveryFlowEpochRef = useRef(0);

  /** Step 1 proves the phrase opens the account, so the password step cannot be reached with the wrong one. */
  async function handleRecoveryPhraseNext(): Promise<void> {
    if (verifyInFlightRef.current) return;
    verifyInFlightRef.current = true;
    setIsVerifying(true);
    setVerificationError(null);
    const epoch = recoveryFlowEpochRef.current;
    try {
      const result = await verifyRecoveryPhrase(identifier, recoveryPhrase);
      if (result.success) {
        if (epoch !== recoveryFlowEpochRef.current) {
          // The user left while this ran. Nothing is reading this material and
          // nobody will retry with it, so it is discarded rather than kept.
          discardVerifiedRecoveryPhrase(result.verified);
          return;
        }
        setVerified(result.verified);
        setMode('recovery-new-password');
      } else {
        setVerificationError(result.error);
      }
    } catch {
      setVerificationError('Could not check that recovery phrase. Please try again.');
    } finally {
      verifyInFlightRef.current = false;
      setIsVerifying(false);
    }
  }

  function leaveRecoveryStep(next: Mode): void {
    recoveryFlowEpochRef.current += 1;
    if (verified) discardVerifiedRecoveryPhrase(verified);
    setVerified(null);
    // Nothing from an abandoned attempt survives the exit; a stale error would
    // otherwise be waiting in the parent when the phrase form remounts.
    setVerificationError(null);
    setMode(next);
  }

  async function handleResetPassword(handle: VerifiedRecoveryPhrase): Promise<void> {
    if (resetInFlightRef.current) return;
    resetInFlightRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      const result = await resetPasswordViaRecovery(handle, newPassword);
      if (result.success) {
        setMode('recovery-success');
      } else {
        setError(result.error ?? 'Password reset failed');
        setErrorKey((k) => k + 1);
      }
    } catch {
      setError('Password reset failed. Please try again.');
      setErrorKey((k) => k + 1);
    } finally {
      resetInFlightRef.current = false;
      setIsLoading(false);
    }
  }

  const handle2FASuccess = useCallback(() => {
    void navigate({ to: ROUTES.CHAT });
  }, [navigate]);

  function leaveTwoFactorStep(): void {
    // A phone keeps its keyboard down: the heading takes focus there, not the field.
    landingAfterStepRef.current = band === 'phone' ? 'heading' : 'password';
    setVerifyTOTP(null);
    setPassword('');
  }

  useEffect(() => {
    const landing = landingAfterStepRef.current;
    if (verifyTOTP !== null || landing === null) return;
    landingAfterStepRef.current = null;
    if (landing === 'heading') {
      focusHeading(loginViewRef.current);
    } else {
      loginFormRef.current?.querySelector<HTMLInputElement>('#password')?.focus();
    }
  }, [verifyTOTP]);

  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();

    setTouched({ identifier: true, password: true });

    const identifierResult = validateIdentifier(identifier);
    const passwordResult = validatePassword(password);

    if (!identifierResult.isValid || !passwordResult.isValid) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await signIn.email({ identifier, password, keepSignedIn });
      if (response.error) {
        if (response.error.code === 'EMAIL_NOT_VERIFIED') {
          setUnverifiedEmail(identifier);
          setMode('email-not-verified');
          return;
        }
        setError(response.error.message);
        setErrorKey((k) => k + 1);
        return;
      }
      if (response.requires2FA && response.verifyTOTP) {
        const verifier = response.verifyTOTP;
        setVerifyTOTP(() => verifier);
        return;
      }
      void navigate({ to: ROUTES.CHAT });
    } finally {
      setIsLoading(false);
    }
  }

  if (mode === 'recovery-phrase') {
    return (
      <RecoveryPhraseForm
        identifier={identifier}
        setIdentifier={setIdentifier}
        recoveryPhrase={recoveryPhrase}
        setRecoveryPhrase={setRecoveryPhrase}
        verificationError={verificationError}
        clearVerificationError={() => {
          setVerificationError(null);
        }}
        isVerifying={isVerifying}
        onNext={handleRecoveryPhraseNext}
        onBackToLogin={() => {
          leaveRecoveryStep('login');
        }}
      />
    );
  }

  if (mode === 'recovery-new-password' && verified) {
    return (
      <RecoveryNewPasswordForm
        newPassword={newPassword}
        setNewPassword={setNewPassword}
        confirmPassword={confirmPassword}
        setConfirmPassword={setConfirmPassword}
        error={error}
        errorKey={errorKey}
        isLoading={isLoading}
        onResetPassword={() => handleResetPassword(verified)}
        onBackToRecovery={() => {
          leaveRecoveryStep('recovery-phrase');
        }}
      />
    );
  }

  if (mode === 'recovery-success') {
    return (
      <RecoverySuccessView
        onReturnToLogin={() => {
          leaveRecoveryStep('login');
          setRecoveryPhrase('');
          setNewPassword('');
          setConfirmPassword('');
        }}
      />
    );
  }

  if (mode === 'email-not-verified') {
    return <CheckYourEmail email={unverifiedEmail} autoResend />;
  }

  if (verifyTOTP) {
    return (
      <TwoFactorLoginStep
        onVerify={verifyTOTP}
        onSuccess={handle2FASuccess}
        onBack={leaveTwoFactorStep}
      />
    );
  }

  return (
    <div ref={loginViewRef}>
      <AuthFormHeader title="Welcome back" subtitle={PRODUCT_TAGLINE} subtitleTone="tagline" />

      <form
        ref={loginFormRef}
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-2"
        noValidate
      >
        <IdentifierField
          identifier={identifier}
          setIdentifier={setIdentifier}
          touched={touched.identifier}
          markTouched={() => {
            setTouched((t) => ({ ...t, identifier: true }));
          }}
        />

        <PasswordField
          id="password"
          label="Password"
          autoComplete="current-password"
          password={password}
          setPassword={setPassword}
          touched={touched.password}
          markTouched={() => {
            setTouched((t) => ({ ...t, password: true }));
          }}
        />

        {/* The check's label wraps before the link does; the link drops below only when
            the check's longest word no longer fits beside it. */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="w-min max-w-max grow">
            <CheckField
              id="keep-signed-in"
              checked={keepSignedIn}
              onCheckedChange={setKeepSignedIn}
              label="Keep me signed in"
              size="lg"
            />
          </div>
          <button
            type="button"
            className="text-primary max-w-full shrink-0 cursor-pointer text-start text-sm hover:underline"
            onClick={() => {
              setMode('recovery-phrase');
            }}
          >
            Forgot password?
          </button>
        </div>

        <InlineFormError error={error} errorKey={errorKey} />

        <Button type="submit" size="xl" block disabled={isLoading}>
          {isLoading ? 'Logging in...' : 'Log in'}
        </Button>

        <p className="text-muted-foreground mt-2 text-center text-sm">
          Don&apos;t have an account?{' '}
          <Link to={ROUTES.SIGNUP} className="text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </form>

      <AuthFeatureList />
    </div>
  );
}
