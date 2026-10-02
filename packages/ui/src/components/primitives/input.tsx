import * as React from 'react';
import { useId, useState } from 'react';
import { TEST_IDS } from '@hushbox/shared';

import { cn } from '../../lib/utilities';
import { SIMPLE_INPUT_CLASSES } from '../field/simple-input-classes';

interface InputProps extends React.ComponentProps<'input'> {
  label?: string;
  icon?: React.ReactNode;
  suffix?: React.ReactNode;
}

const SIMPLE_INPUT_ERROR_CLASSES = 'aria-invalid:border-destructive';

function resolveInputId(id: string | undefined, generatedId: string): string {
  return id ?? generatedId;
}

function getLabelClassName(hasIcon: boolean, isActive: boolean): string {
  const positionClass = hasIcon ? 'left-10' : 'left-3';
  const stateClass = isActive
    ? 'text-primary top-2 text-xs'
    : 'text-muted-foreground top-1/2 -translate-y-1/2 text-sm';

  return cn('pointer-events-none absolute transition-all duration-200', positionClass, stateClass);
}

function getEnhancedInputClassName(
  hasLabel: boolean,
  hasIcon: boolean,
  hasSuffix: boolean,
  className?: string
): string {
  const paddingLeft = hasIcon ? 'pl-10' : 'pl-3';
  const paddingY = hasLabel ? 'pt-6 pb-2' : 'py-3';
  const paddingRight = hasSuffix ? 'pr-10' : 'pr-3';

  return cn(
    'h-auto w-full appearance-none rounded-lg border-2 bg-transparent text-sm shadow-none',
    'border-border-strong focus:border-primary',
    'transition-colors',
    SIMPLE_INPUT_ERROR_CLASSES,
    paddingLeft,
    paddingY,
    paddingRight,
    className
  );
}

function Input({
  className,
  type,
  label,
  icon,
  suffix,
  id,
  value,
  onFocus,
  onBlur,
  ...props
}: Readonly<InputProps>): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const generatedId = useId();
  const inputId = resolveInputId(id, generatedId);
  const hasValue = value !== undefined && String(value).length > 0;
  const isActive = focused || hasValue;
  const hasLabel = !!label;
  const hasIcon = !!icon;
  const hasSuffix = !!suffix;
  const isSimpleInput = !hasLabel && !hasIcon && !hasSuffix;

  function handleFocus(e: React.FocusEvent<HTMLInputElement>): void {
    setFocused(true);
    onFocus?.(e);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>): void {
    setFocused(false);
    onBlur?.(e);
  }

  if (isSimpleInput) {
    return (
      <input
        type={type}
        id={id}
        value={value}
        onFocus={onFocus}
        onBlur={onBlur}
        data-slot="input"
        className={cn(SIMPLE_INPUT_CLASSES, 'border-input focus-visible:outline-hidden', className)}
        {...props}
      />
    );
  }

  return (
    <div className="relative">
      {hasLabel && (
        <label htmlFor={inputId} className={getLabelClassName(hasIcon, isActive)}>
          {label}
        </label>
      )}

      {hasIcon && (
        <div
          data-testid={TEST_IDS.inputIcon}
          className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
        >
          {icon}
        </div>
      )}

      <input
        type={type}
        id={inputId}
        value={value}
        onFocus={handleFocus}
        onBlur={handleBlur}
        data-slot="input"
        className={getEnhancedInputClassName(hasLabel, hasIcon, hasSuffix, className)}
        {...props}
      />

      {hasSuffix && (
        <div
          data-testid={TEST_IDS.inputSuffix}
          className={cn(
            'absolute right-3 -translate-y-1/2',
            hasLabel ? 'top-[calc(50%+4px)]' : 'top-1/2'
          )}
        >
          {suffix}
        </div>
      )}
    </div>
  );
}

export { Input };
export type { InputProps };
