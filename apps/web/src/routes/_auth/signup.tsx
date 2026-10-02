import * as React from 'react';
import { useState, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PRODUCT_TAGLINE, RELEASE_STAGE, ROUTES, campaignTagSchema } from '@hushbox/shared';
import { InlineFormError } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { TextField } from '@hushbox/ui/field';
import { Mail, User } from '@hushbox/ui/icons';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { signUp } from '@/lib/auth/auth';
import { AuthFormHeader } from '@/components/auth/auth-form-header';
import { PasswordField, ConfirmPasswordField } from '@/components/auth/password-field';
import { AuthFeatureList } from '@/components/auth/auth-feature-list';
import { BetaWelcomeStep } from '@/components/auth/beta-welcome-step';
import { CheckYourEmail } from '@/components/auth/check-your-email';
import { ExternalPageLink } from '@/components/shared/external-page-link';
import {
  validateUsername,
  validateEmail,
  validatePassword,
  validateConfirmPassword,
} from '@/lib/auth/validation';

/**
 * The campaign tag the link carried, and the only thing this route reads off
 * the page — not its own path, not the referrer. The tag rides the address bar
 * and nothing stores it: no cookie, no `sessionStorage`, no first-touch record,
 * so it lives as long as the tab and dies with it.
 *
 * A malformed tag is simply no tag. A signup form is the wrong place to refuse
 * a request over a marketing label, and the server folds an unrecognised tag
 * into `unknown` rather than rejecting it for the same reason.
 */
function validateSignupSearch(search: Record<string, unknown>): { c?: string } {
  const tag = campaignTagSchema.safeParse(search['c']);
  return tag.success ? { c: tag.data } : {};
}

/** A validation result's lines, as the field's optional props take them. */
function fieldMessages(validation: { error?: string | undefined; success?: string | undefined }): {
  error?: string;
  success?: string;
} {
  return {
    ...(validation.error === undefined ? {} : { error: validation.error }),
    ...(validation.success === undefined ? {} : { success: validation.success }),
  };
}

export const Route = createFileRoute('/_auth/signup')({
  component: SignupPage,
  validateSearch: validateSignupSearch,
});

function SignupPage(): React.JSX.Element {
  const { c: campaign } = Route.useSearch();
  const [isFormShown, setIsFormShown] = useState(RELEASE_STAGE !== 'beta');
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
  const usernameRef = useRef<HTMLInputElement>(null);
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
      const response = await signUp.email({ username, email, password, campaign });
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

  if (!isFormShown) {
    return (
      <BetaWelcomeStep
        onJoin={() => {
          // The button that held focus is gone once the form renders, so focus moves on with
          // the user instead of falling back to the page.
          flushSync(() => {
            setIsFormShown(true);
          });
          usernameRef.current?.focus();
        }}
      />
    );
  }

  return (
    <div>
      <AuthFormHeader
        title="Create your account"
        subtitle={PRODUCT_TAGLINE}
        subtitleTone="tagline"
      />

      <form
        ref={formRef}
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-2"
        noValidate
      >
        <TextField
          ref={usernameRef}
          id="username"
          label="Username"
          type="text"
          icon={User}
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            if (!touched.username) setTouched((t) => ({ ...t, username: true }));
          }}
          aria-invalid={!!usernameValidation.error}
          {...fieldMessages(usernameValidation)}
        />

        <TextField
          id="email"
          label="Email"
          type="email"
          icon={Mail}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (!touched.email) setTouched((t) => ({ ...t, email: true }));
          }}
          aria-invalid={!!emailValidation.error}
          {...fieldMessages(emailValidation)}
        />

        <PasswordField
          id="password"
          label="Password"
          autoComplete="new-password"
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

        <InlineFormError error={error} errorKey={errorKey} />

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

        <Button type="submit" size="xl" block disabled={isLoading}>
          {isLoading ? 'Creating account...' : 'Create account'}
        </Button>

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
