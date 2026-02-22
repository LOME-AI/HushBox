import * as React from 'react';
import { useState, useRef, useCallback } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { signIn, resetPasswordViaRecovery } from '@/lib/auth';
import { useFormEnterNav } from '@/hooks/use-form-enter-nav';
import { CheckboxField } from '@/components/shared/checkbox-field';
import { IdentifierInput } from '@/components/auth/identifier-input';
import { AuthButton } from '@/components/auth/AuthButton';
import { AuthPasswordInput } from '@/components/auth/AuthPasswordInput';
import { TwoFactorInput } from '@/components/auth/TwoFactorInput';
import { AuthFeatureList } from '@/components/auth/auth-feature-list';
import { AuthShakeError } from '@/components/auth/auth-shake-error';
import {
  validateIdentifier,
  validatePassword,
  validateConfirmPassword,
  validateRecoveryPhrase,
} from '@/lib/validation';
import { ROUTES } from '@hushbox/shared';

export const Route = createFileRoute('/_auth/login')({
  component: LoginPage,
});

type Mode = 'login' | 'recovery-phrase' | 'recovery-new-password' | 'recovery-success';

interface RecoveryPhraseFormProps {
  identifier: string;
  setIdentifier: (identifier: string) => void;
  recoveryPhrase: string;
  setRecoveryPhrase: (phrase: string) => void;
  onNext: () => void;
  onBackToLogin: () => void;
}

function RecoveryPhraseForm({
  identifier,
  setIdentifier,
  recoveryPhrase,
  setRecoveryPhrase,
  onNext,
  onBackToLogin,
}: Readonly<RecoveryPhraseFormProps>): React.JSX.Element {
  const [touched, setTouched] = useState({ identifier: false, recoveryPhrase: false });
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);

  const identifierValidation = touched.identifier
    ? validateIdentifier(identifier)
    : { isValid: false };
  const phraseValidation = touched.recoveryPhrase
    ? validateRecoveryPhrase(recoveryPhrase)
    : { isValid: false };

  function handleNext(): void {
    setTouched({ identifier: true, recoveryPhrase: true });

    const iv = validateIdentifier(identifier);
    const pv = validateRecoveryPhrase(recoveryPhrase);

    if (!iv.isValid || !pv.isValid) {
      return;
    }

    onNext();
  }

  return (
    <div>
      <div className="mb-5 text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Reset Password</h1>
        <p className="text-primary text-lg font-medium">
          Enter your email or username and 12-word recovery phrase
        </p>
      </div>

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          handleNext();
        }}
        className="space-y-2"
        noValidate
      >
        <IdentifierInput
          id="identifier"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value);
            if (!touched.identifier) setTouched((t) => ({ ...t, identifier: true }));
          }}
          aria-invalid={!!identifierValidation.error}
          error={identifierValidation.error}
          success={identifierValidation.success}
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
              setRecoveryPhrase(e.target.value);
              if (!touched.recoveryPhrase) setTouched((t) => ({ ...t, recoveryPhrase: true }));
            }}
            aria-invalid={!!phraseValidation.error}
            className="bg-background border-border focus:border-primary focus:ring-primary min-h-[100px] w-full rounded-lg border px-4 py-3 text-sm focus:ring-2 focus:outline-none"
          />
          {touched.recoveryPhrase && phraseValidation.error && (
            <p role="alert" className="text-destructive mt-1 text-sm">
              {phraseValidation.error}
            </p>
          )}
          {touched.recoveryPhrase && !phraseValidation.error && phraseValidation.success && (
            <p className="text-success mt-1 text-sm">{phraseValidation.success}</p>
          )}
        </div>

        <AuthButton
          type="button"
          className="w-full"
          onClick={() => {
            handleNext();
          }}
        >
          Next
        </AuthButton>

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

  const passwordValidation = touched.newPassword
    ? validatePassword(newPassword)
    : { isValid: false };
  const confirmPasswordValidation = touched.confirmPassword
    ? validateConfirmPassword(newPassword, confirmPassword)
    : { isValid: false };

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
      <div className="mb-5 text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Create New Password</h1>
        <p className="text-primary text-lg font-medium">Enter your new password</p>
      </div>

      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        className="space-y-2"
        noValidate
      >
        <AuthPasswordInput
          id="new-password"
          label="New Password"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            if (!touched.newPassword) setTouched((t) => ({ ...t, newPassword: true }));
          }}
          aria-invalid={!!passwordValidation.error}
          error={passwordValidation.error}
          success={passwordValidation.success}
          showStrength
        />

        <AuthPasswordInput
          id="confirm-password"
          label="Confirm Password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (!touched.confirmPassword) setTouched((t) => ({ ...t, confirmPassword: true }));
          }}
          aria-invalid={!!confirmPasswordValidation.error}
          error={confirmPasswordValidation.error}
          success={confirmPasswordValidation.success}
        />

        <AuthShakeError error={error} errorKey={errorKey} />

        <AuthButton
          type="button"
          className="w-full"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={isLoading}
        >
          {isLoading ? 'Resetting...' : 'Reset Password'}
        </AuthButton>

        <p className="text-muted-foreground mt-2 text-center text-sm">
          Go back?{' '}
          <button
            type="button"
            className="text-primary cursor-pointer hover:underline"
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
      <div className="mb-5 text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Password Reset Successful</h1>
        <p className="text-muted-foreground text-sm">
          Your password has been successfully reset. You can now log in with your new password.
        </p>
      </div>

      <AuthButton type="button" className="w-full" onClick={onReturnToLogin}>
        Return to Login
      </AuthButton>
    </div>
  );
}

export function LoginPage(): React.JSX.Element {
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
  const [show2FA, setShow2FA] = useState(false);
  const verifyTOTPRef = useRef<
    ((code: string) => Promise<{ success: boolean; error?: string }>) | null
  >(null);
  const loginFormRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(loginFormRef);

  const identifierValidation = touched.identifier
    ? validateIdentifier(identifier)
    : { isValid: false };
  const passwordValidation = touched.password ? validatePassword(password) : { isValid: false };

  function handleRecoveryPhraseNext(): void {
    setMode('recovery-new-password');
  }

  async function handleResetPassword(): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const result = await resetPasswordViaRecovery(identifier, recoveryPhrase, newPassword);
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
      setIsLoading(false);
    }
  }

  const handle2FASuccess = useCallback(() => {
    setShow2FA(false);
    void navigate({ to: ROUTES.CHAT });
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
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
        setError(response.error.message);
        setErrorKey((k) => k + 1);
        return;
      }
      if (response.requires2FA && response.verifyTOTP) {
        verifyTOTPRef.current = response.verifyTOTP;
        setShow2FA(true);
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
        onNext={handleRecoveryPhraseNext}
        onBackToLogin={() => {
          setMode('login');
        }}
      />
    );
  }

  if (mode === 'recovery-new-password') {
    return (
      <RecoveryNewPasswordForm
        newPassword={newPassword}
        setNewPassword={setNewPassword}
        confirmPassword={confirmPassword}
        setConfirmPassword={setConfirmPassword}
        error={error}
        errorKey={errorKey}
        isLoading={isLoading}
        onResetPassword={handleResetPassword}
        onBackToRecovery={() => {
          setMode('recovery-phrase');
        }}
      />
    );
  }

  if (mode === 'recovery-success') {
    return (
      <RecoverySuccessView
        onReturnToLogin={() => {
          setMode('login');
          setRecoveryPhrase('');
          setNewPassword('');
          setConfirmPassword('');
        }}
      />
    );
  }

  return (
    <div>
      <div className="mb-5 text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Welcome back</h1>
        <p className="text-primary text-lg font-medium">One interface. Every AI model. Private.</p>
      </div>

      <form
        ref={loginFormRef}
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-2"
        noValidate
      >
        <IdentifierInput
          id="identifier"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value);
            if (!touched.identifier) setTouched((t) => ({ ...t, identifier: true }));
          }}
          aria-invalid={!!identifierValidation.error}
          error={identifierValidation.error}
          success={identifierValidation.success}
        />

        <AuthPasswordInput
          id="password"
          label="Password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (!touched.password) setTouched((t) => ({ ...t, password: true }));
          }}
          aria-invalid={!!passwordValidation.error}
          error={passwordValidation.error}
          success={passwordValidation.success}
        />

        <div className="flex items-center justify-between">
          <CheckboxField
            id="keep-signed-in"
            checked={keepSignedIn}
            onCheckedChange={setKeepSignedIn}
            label="Keep me signed in"
          />
          <button
            type="button"
            className="text-primary cursor-pointer text-sm hover:underline"
            onClick={() => {
              setMode('recovery-phrase');
            }}
          >
            Forgot password?
          </button>
        </div>

        <AuthShakeError error={error} errorKey={errorKey} />

        <AuthButton type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? 'Logging in...' : 'Log in'}
        </AuthButton>

        <p className="text-muted-foreground mt-2 text-center text-sm">
          Don&apos;t have an account?{' '}
          <Link to={ROUTES.SIGNUP} className="text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </form>

      <AuthFeatureList />

      {verifyTOTPRef.current && (
        <TwoFactorInput
          open={show2FA}
          onOpenChange={setShow2FA}
          onSuccess={handle2FASuccess}
          onVerify={verifyTOTPRef.current}
        />
      )}
    </div>
  );
}
