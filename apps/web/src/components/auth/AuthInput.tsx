import * as React from 'react';
import { useEffect, useId, useState } from 'react';
import { Input, cn, type InputProps } from '@lome-chat/ui';

interface AuthInputProps extends InputProps {
  error?: string | undefined;
  success?: string | undefined;
}

export function AuthInput({
  error,
  success,
  className,
  value,
  id,
  ...props
}: AuthInputProps): React.JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const feedbackId = `${inputId}-feedback`;
  const [hasBeenTouched, setHasBeenTouched] = useState(false);
  const hasValue = value !== undefined && String(value).length > 0;
  const hasFeedback = Boolean(error ?? success);

  // Track when input first receives a value (stays true permanently)
  useEffect(() => {
    if (hasValue && !hasBeenTouched) {
      setHasBeenTouched(true);
    }
  }, [hasValue, hasBeenTouched]);

  return (
    <div>
      <Input
        id={inputId}
        value={value}
        className={cn(error && 'border-destructive', className)}
        aria-invalid={Boolean(error)}
        aria-describedby={hasFeedback ? feedbackId : undefined}
        {...props}
      />

      {/* Feedback area - animates height on first input, then fades in text */}
      <div
        id={feedbackId}
        data-testid="auth-input-feedback"
        className={cn(
          'mt-1 overflow-hidden transition-[height] duration-150 ease-out',
          hasBeenTouched ? 'h-5' : 'h-0'
        )}
      >
        {error && (
          <p
            role="alert"
            className={cn(
              'text-destructive text-xs transition-opacity duration-200',
              hasBeenTouched ? 'opacity-100 delay-150' : 'opacity-0'
            )}
          >
            {error}
          </p>
        )}
        {!error && success && (
          <p
            className={cn(
              'text-success text-xs transition-opacity duration-200',
              hasBeenTouched ? 'opacity-100 delay-150' : 'opacity-0'
            )}
          >
            {success}
          </p>
        )}
      </div>
    </div>
  );
}

export type { AuthInputProps };
