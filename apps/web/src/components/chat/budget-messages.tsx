import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@lome-chat/ui';
import type { BudgetError } from '@lome-chat/shared';

interface BudgetMessagesProps {
  /** Array of budget errors/warnings/info to display */
  errors: BudgetError[];
  /** Additional CSS classes */
  className?: string;
}

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

function getIcon(type: BudgetError['type']): React.ComponentType<{ className?: string }> {
  switch (type) {
    case 'error':
    case 'warning':
      return AlertTriangle;
    case 'info':
      return Info;
  }
}

export function BudgetMessages({ errors, className }: BudgetMessagesProps): React.JSX.Element {
  if (errors.length === 0) {
    return <></>;
  }

  return (
    <div
      data-testid="budget-messages"
      className={cn('flex flex-col gap-2', className)}
      role="region"
      aria-live="polite"
    >
      <AnimatePresence>
        {errors.map((error) => {
          const Icon = getIcon(error.type);
          return (
            <motion.div
              key={error.id}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div
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
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
