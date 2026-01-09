import * as React from 'react';
import { useState } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';
import { FormInput, type FormInputProps } from '@/components/shared/form-input';

interface AuthPasswordInputProps extends Omit<FormInputProps, 'type' | 'icon' | 'suffix'> {
  label: string;
}

export function AuthPasswordInput({
  label,
  className,
  ...props
}: AuthPasswordInputProps): React.JSX.Element {
  const [showPassword, setShowPassword] = useState(false);

  function toggleVisibility(): void {
    setShowPassword((prev) => !prev);
  }

  const visibilityToggle = (
    <button
      type="button"
      onClick={toggleVisibility}
      className="text-foreground/50 hover:text-foreground transition-colors"
      aria-label={showPassword ? 'Hide password' : 'Show password'}
    >
      {showPassword ? (
        <EyeOff className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Eye className="h-5 w-5" aria-hidden="true" />
      )}
    </button>
  );

  return (
    <FormInput
      type={showPassword ? 'text' : 'password'}
      label={label}
      icon={<Lock className="h-5 w-5" aria-hidden="true" />}
      suffix={visibilityToggle}
      className={className}
      {...props}
    />
  );
}
