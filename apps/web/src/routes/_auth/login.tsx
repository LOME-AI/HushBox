import * as React from 'react';
import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import { signIn } from '@/lib/auth';
import { FormInput } from '@/components/shared/form-input';
import { AuthButton } from '@/components/auth/AuthButton';
import { AuthPasswordInput } from '@/components/auth/AuthPasswordInput';
import { validateEmail, validatePassword } from '@/lib/validation';

export const Route = createFileRoute('/_auth/login')({
  component: LoginPage,
});

export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState({ email: false, password: false });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);

  const emailValidation = touched.email ? validateEmail(email) : { isValid: false };
  const passwordValidation = touched.password ? validatePassword(password) : { isValid: false };

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();

    setTouched({ email: true, password: true });

    const emailResult = validateEmail(email);
    const passwordResult = validatePassword(password);

    if (!emailResult.isValid || !passwordResult.isValid) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await signIn.email({ email, password });
      if (response.error) {
        setError(response.error.message ?? 'Authentication failed');
        setErrorKey((k) => k + 1);
        return;
      }
      void navigate({ to: '/chat' });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-8 text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Welcome back</h1>
        <p className="text-primary text-lg font-medium">One interface. Every AI model.</p>
      </div>

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-4"
        noValidate
      >
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

        {error && (
          <p
            key={errorKey}
            role="alert"
            className="text-destructive animate-shake text-center text-sm"
          >
            {error}
          </p>
        )}

        <AuthButton type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? 'Logging in...' : 'Log in'}
        </AuthButton>

        <p className="text-muted-foreground text-center text-sm">
          Don&apos;t have an account?{' '}
          <Link to="/signup" className="text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </form>

      <div className="border-border mt-8 border-t pt-6">
        <ul className="text-muted-foreground space-y-3 text-sm">
          <li className="flex items-center gap-3">
            <span className="text-primary text-lg">✓</span>
            Access GPT, Claude, Gemini & more
          </li>
          <li className="flex items-center gap-3">
            <span className="text-primary text-lg">✓</span>
            Switch models mid-conversation
          </li>
          <li className="flex items-center gap-3">
            <span className="text-primary text-lg">✓</span>
            Privacy by design
          </li>
        </ul>
      </div>
    </div>
  );
}
