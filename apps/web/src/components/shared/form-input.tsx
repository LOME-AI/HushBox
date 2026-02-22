import * as React from 'react';
import { useId, useState } from 'react';
import { Input, cn, type InputProps } from '@hushbox/ui';

interface FormInputProps extends Omit<InputProps, 'placeholder'> {
  error?: string | undefined;
  success?: string | undefined;
}

interface FeedbackProps {
  error?: string | undefined;
  success?: string | undefined;
  showFeedback: boolean;
  feedbackId: string;
}

function FormInputFeedback({
  error,
  success,
  showFeedback,
  feedbackId,
}: Readonly<FeedbackProps>): React.JSX.Element {
  const opacityClass = showFeedback ? 'opacity-100 delay-150' : 'opacity-0';

  const feedbackContent = error ? (
    <p
      role="alert"
      className={cn('text-destructive text-xs transition-opacity duration-200', opacityClass)}
    >
      {error}
    </p>
  ) : null;

  const successContent =
    !error && success ? (
      <p className={cn('text-success text-xs transition-opacity duration-200', opacityClass)}>
        {success}
      </p>
    ) : null;

  return (
    <div
      id={feedbackId}
      data-testid="form-input-feedback"
      className={cn(
        'mt-1 overflow-hidden transition-[height] duration-150 ease-out',
        showFeedback ? 'h-5' : 'h-0'
      )}
    >
      {feedbackContent}
      {successContent}
    </div>
  );
}

export function FormInput({
  error,
  success,
  className,
  value,
  id,
  onFocus,
  onBlur,
  ...props
}: Readonly<FormInputProps>): React.JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const feedbackId = `${inputId}-feedback`;
  const [isFocused, setIsFocused] = useState(false);
  const hasFeedback = Boolean(error ?? success);
  const showFeedback = hasFeedback && (isFocused || Boolean(error));

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>): void => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>): void => {
    setIsFocused(false);
    onBlur?.(e);
  };

  return (
    <div>
      <Input
        id={inputId}
        value={value}
        className={cn(error && 'border-destructive', className)}
        aria-invalid={Boolean(error)}
        aria-describedby={hasFeedback ? feedbackId : undefined}
        onFocus={handleFocus}
        onBlur={handleBlur}
        {...props}
      />
      <FormInputFeedback
        error={error}
        success={success}
        showFeedback={showFeedback}
        feedbackId={feedbackId}
      />
    </div>
  );
}

export type { FormInputProps };
