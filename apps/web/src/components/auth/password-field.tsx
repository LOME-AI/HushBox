import * as React from 'react';
import { AuthPasswordInput } from '@/components/auth/AuthPasswordInput';
import { validatePassword, validateConfirmPassword } from '@/lib/validation';

interface PasswordFieldProps {
  id: string;
  label: string;
  password: string;
  setPassword: (value: string) => void;
  touched: boolean;
  markTouched: () => void;
  showStrength?: boolean;
}

export function PasswordField({
  id,
  label,
  password,
  setPassword,
  touched,
  markTouched,
  showStrength,
}: Readonly<PasswordFieldProps>): React.JSX.Element {
  const validation = touched ? validatePassword(password) : { isValid: false };
  return (
    <AuthPasswordInput
      id={id}
      label={label}
      value={password}
      onChange={(e) => {
        setPassword(e.target.value);
        if (!touched) markTouched();
      }}
      aria-invalid={!!validation.error}
      error={validation.error}
      success={validation.success}
      showStrength={showStrength ?? false}
    />
  );
}

interface ConfirmPasswordFieldProps {
  id: string;
  label: string;
  newPassword: string;
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  touched: boolean;
  markTouched: () => void;
}

export function ConfirmPasswordField({
  id,
  label,
  newPassword,
  confirmPassword,
  setConfirmPassword,
  touched,
  markTouched,
}: Readonly<ConfirmPasswordFieldProps>): React.JSX.Element {
  const validation = touched
    ? validateConfirmPassword(newPassword, confirmPassword)
    : { isValid: false };
  return (
    <AuthPasswordInput
      id={id}
      label={label}
      value={confirmPassword}
      onChange={(e) => {
        setConfirmPassword(e.target.value);
        if (!touched) markTouched();
      }}
      aria-invalid={!!validation.error}
      error={validation.error}
      success={validation.success}
    />
  );
}
