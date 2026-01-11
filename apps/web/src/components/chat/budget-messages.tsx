import * as React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@lome-chat/ui';
import type { BudgetError } from '@lome-chat/shared';

interface BudgetMessagesProps {
  /** Array of budget errors/warnings/info to display */
  errors: BudgetError[];
  /** Additional CSS classes */
  className?: string;
}

/**
 * Get border color class based on error type.
 * Uses colored left border for visual distinction while keeping text neutral.
 */
function getBorderColor(type: BudgetError['type']): string {
  switch (type) {
    case 'error':
      return 'border-l-destructive';
    case 'warning':
      return 'border-l-yellow-500';
    case 'info':
      return 'border-l-blue-500';
  }
}

/**
 * Get icon color class based on error type.
 * Icons retain semantic colors for visual indication.
 */
function getIconColor(type: BudgetError['type']): string {
  switch (type) {
    case 'error':
      return 'text-destructive';
    case 'warning':
      return 'text-yellow-500';
    case 'info':
      return 'text-blue-500';
  }
}

/**
 * Get icon component based on error type.
 */
function getIcon(type: BudgetError['type']): React.ComponentType<{ className?: string }> {
  switch (type) {
    case 'error':
    case 'warning':
      return AlertTriangle;
    case 'info':
      return Info;
  }
}

/**
 * Component to display budget-related messages (errors, warnings, info).
 * Uses accessible styling: neutral background + colored left border + colored icon.
 * Renders below the prompt input to inform users about budget/capacity issues.
 */
export function BudgetMessages({
  errors,
  className,
}: BudgetMessagesProps): React.JSX.Element | null {
  if (errors.length === 0) {
    return null;
  }

  return (
    <div data-testid="budget-messages" className={cn('flex flex-col gap-2', className)}>
      {errors.map((error) => {
        const Icon = getIcon(error.type);
        return (
          <div
            key={error.id}
            data-testid={`budget-message-${error.id}`}
            role="alert"
            className={cn(
              'flex items-center gap-2 rounded px-3 py-2 text-sm',
              'bg-muted/50 text-foreground border-l-3',
              getBorderColor(error.type)
            )}
          >
            <Icon
              data-testid={`budget-message-icon-${error.id}`}
              className={cn('h-4 w-4 shrink-0', getIconColor(error.type))}
            />
            <span>{error.message}</span>
          </div>
        );
      })}
    </div>
  );
}
