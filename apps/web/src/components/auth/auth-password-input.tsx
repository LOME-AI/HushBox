import * as React from 'react';
import { useState } from 'react';
import { TextField } from '@hushbox/ui/field';
import { Eye, EyeOff, Lock } from '@hushbox/ui/icons';
import { PasswordStrength } from '@/components/auth/password-strength';

type AuthPasswordInputProps = Omit<
  React.ComponentProps<'input'>,
  'type' | 'placeholder' | 'size'
> & {
  label: string;
  error?: string | undefined;
  success?: string | undefined;
  showStrength?: boolean;
};

export function AuthPasswordInput({
  label,
  error,
  success,
  showStrength = false,
  value,
  ...props
}: Readonly<AuthPasswordInputProps>): React.JSX.Element {
  const [showPassword, setShowPassword] = useState(false);
  const Glyph = showPassword ? EyeOff : Eye;

  const visibilityToggle = (
    <button
      type="button"
      onClick={() => {
        setShowPassword((previous) => !previous);
      }}
      className="hover:text-foreground transition-colors"
      aria-label={showPassword ? 'Hide password' : 'Show password'}
    >
      <Glyph className="h-5 w-5" aria-hidden="true" />
    </button>
  );

  return (
    <div>
      <TextField
        type={showPassword ? 'text' : 'password'}
        label={label}
        icon={Lock}
        suffix={visibilityToggle}
        value={value}
        {...(error === undefined ? {} : { error })}
        {...(success === undefined ? {} : { success })}
        {...props}
      />
      {showStrength && <PasswordStrength password={String(value ?? '')} />}
    </div>
  );
}
