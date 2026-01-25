import * as React from 'react';
import { cn } from '@lome-chat/ui';

interface PasswordStrengthProps {
  password: string;
}

function calculateStrength(password: string): number {
  if (!password) return 0;
  if (password.length < 8) return 1;

  const criteriaCount = [
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password),
    /[!@#$%^&*(),.?":{}|<>]/.test(password),
  ].filter(Boolean).length;

  if (password.length >= 10 && criteriaCount >= 2) return 3;
  if (criteriaCount >= 1) return 2;
  return 1;
}

function getStrengthLabel(strength: number): string {
  switch (strength) {
    case 1: {
      return 'Weak';
    }
    case 2: {
      return 'Medium';
    }
    case 3: {
      return 'Strong';
    }
    default: {
      return '';
    }
  }
}

function getStrengthColor(strength: number): string {
  switch (strength) {
    case 1: {
      return 'bg-error';
    }
    case 2: {
      return 'bg-warning';
    }
    case 3: {
      return 'bg-success';
    }
    default: {
      return 'bg-border';
    }
  }
}

export function PasswordStrength({ password }: Readonly<PasswordStrengthProps>): React.JSX.Element {
  const strength = calculateStrength(password);
  const hasPassword = password.length > 0;

  return (
    <div
      data-testid="strength-indicator"
      className={cn(
        'mt-1 overflow-hidden transition-[height] duration-150 ease-out',
        hasPassword ? 'h-6' : 'h-0'
      )}
    >
      <div
        className={cn(
          'space-y-1 transition-opacity duration-200',
          hasPassword ? 'opacity-100 delay-150' : 'opacity-0'
        )}
      >
        <div className="flex gap-1">
          {[1, 2, 3].map((segment) => (
            <div
              key={segment}
              data-testid="strength-segment"
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                segment <= strength ? getStrengthColor(strength) : 'bg-border'
              )}
            />
          ))}
        </div>
        <p className="text-muted-foreground text-xs">{getStrengthLabel(strength)}</p>
      </div>
    </div>
  );
}
