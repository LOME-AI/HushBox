import * as React from 'react';
import { useState, useRef } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Mail, User } from 'lucide-react';
import { ROUTES } from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/use-form-enter-nav';
import { signUp } from '@/lib/auth';
import { FormInput } from '@/components/shared/form-input';
import { AuthButton } from '@/components/auth/AuthButton';
import { PasswordField, ConfirmPasswordField } from '@/components/auth/password-field';
import { AuthFeatureList } from '@/components/auth/auth-feature-list';
import { AuthShakeError } from '@/components/auth/auth-shake-error';
import { CheckYourEmail } from '@/components/auth/check-your-email';
import { ExternalPageLink } from '@/components/shared/external-page-link';
import {
  validateUsername,
  validateEmail,
  validatePassword,
  validateConfirmPassword,
} from '@/lib/validation';

export const Route = createFileRoute('/_auth/signup')({
  component: SignupPage,
});

export function SignupPage(): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState({
    username: false,
    email: false,
    password: false,
    confirmPassword: false,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);

  const usernameValidation = touched.username ? validateUsername(username) : { isValid: false };
  const emailValidation = touched.email ? validateEmail(email) : { isValid: false };
  async function handleSubmit(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();

    setTouched({ username: true, email: true, password: true, confirmPassword: true });

    const usernameResult = validateUsername(username);
    const emailResult = validateEmail(email);
    const passwordResult = validatePassword(password);
    const confirmPasswordResult = validateConfirmPassword(password, confirmPassword);

    if (
      !usernameResult.isValid ||
      !emailResult.isValid ||
      !passwordResult.isValid ||
      !confirmPasswordResult.isValid
    ) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await signUp.email({ username, email, password });
      if (response.error) {
        setError(response.error.message);
        setErrorKey((k) => k + 1);
        return;
      }
      setIsSuccess(true);
    } finally {
      setIsLoading(false);
    }
  }

  if (isSuccess) {
    return <CheckYourEmail email={email} />;
  }

  return (
    <div>
      <div className="mb-5 text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Create your account</h1>
        <p className="text-primary text-lg font-medium">One interface. Every feature. Private.</p>
      </div>

      <form
        ref={formRef}
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-2"
        noValidate
      >
        <FormInput
          id="username"
          label="Username"
          type="text"
          icon={<User className="h-5 w-5" />}
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (!touched.username) setTouched((t) => ({ ...t, username: true }));
          }}
          aria-invalid={!!usernameValidation.error}
          error={usernameValidation.error}
          success={usernameValidation.success}
        />

        <FormInput
          id="email"
          label="Email"
          type="email"
          icon={<Mail className="h-5 w-5" />}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (!touched.email) setTouched((t) => ({ ...t, email: true }));
          }}
          aria-invalid={!!emailValidation.error}
          error={emailValidation.error}
          success={emailValidation.success}
        />

        <PasswordField
          id="password"
          label="Password"
          password={password}
          setPassword={setPassword}
          touched={touched.password}
          markTouched={() => {
            setTouched((t) => ({ ...t, password: true }));
          }}
          showStrength
        />

        <ConfirmPasswordField
          id="confirmPassword"
          label="Confirm password"
          newPassword={password}
          confirmPassword={confirmPassword}
          setConfirmPassword={setConfirmPassword}
          touched={touched.confirmPassword}
          markTouched={() => {
            setTouched((t) => ({ ...t, confirmPassword: true }));
          }}
        />

        <AuthShakeError error={error} errorKey={errorKey} />

        <p className="text-muted-foreground text-center text-xs">
          By creating an account, you agree to our{' '}
          <ExternalPageLink path={ROUTES.TERMS} className="text-primary hover:underline">
            Terms of Service
          </ExternalPageLink>{' '}
          and{' '}
          <ExternalPageLink path={ROUTES.PRIVACY} className="text-primary hover:underline">
            Privacy Policy
          </ExternalPageLink>
          .
        </p>

        <AuthButton type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? 'Creating account...' : 'Create account'}
        </AuthButton>

        <p className="text-muted-foreground mt-2 text-center text-sm">
          Already have an account?{' '}
          <Link to={ROUTES.LOGIN} className="text-primary hover:underline">
            Log in
          </Link>
        </p>
      </form>

      <AuthFeatureList />
    </div>
  );
}
