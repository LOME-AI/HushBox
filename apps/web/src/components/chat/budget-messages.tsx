import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Info, X } from 'lucide-react';
import { cn, IconButton } from '@hushbox/ui';
import type { BudgetError, MessageSegment } from '@hushbox/shared';

interface BudgetMessagesProps {
  /** Array of budget errors/warnings/info to display */
  errors: BudgetError[];
  /** Additional CSS classes */
  className?: string;
}

function getBorderColor(type: BudgetError['type']): string {
  switch (type) {
    case 'error': {
      return 'border-l-destructive';
    }
    case 'warning': {
      return 'border-l-yellow-500';
    }
    case 'info': {
      return 'border-l-blue-500';
    }
  }
}

function getIconColor(type: BudgetError['type']): string {
  switch (type) {
    case 'error': {
      return 'text-destructive';
    }
    case 'warning': {
      return 'text-yellow-500';
    }
    case 'info': {
      return 'text-blue-500';
    }
  }
}

function getIcon(type: BudgetError['type']): React.ComponentType<{ className?: string }> {
  switch (type) {
    case 'error':
    case 'warning': {
      return AlertTriangle;
    }
    case 'info': {
      return Info;
    }
  }
}

function isDismissible(type: BudgetError['type']): boolean {
  return type !== 'error';
}

function renderMessageContent(error: BudgetError): React.JSX.Element {
  if (!error.segments || error.segments.length === 0) {
    return <>{error.message}</>;
  }

  return (
    <>
      {error.segments.map((segment: MessageSegment, index: number) => {
        if (segment.link) {
          return (
            <Link key={index} to={segment.link} className="text-primary hover:underline">
              {segment.text}
            </Link>
          );
        }
        return <React.Fragment key={index}>{segment.text}</React.Fragment>;
      })}
    </>
  );
}

export function BudgetMessages({
  errors,
  className,
}: Readonly<BudgetMessagesProps>): React.JSX.Element {
  const [dismissedIds, setDismissedIds] = React.useState<Set<string>>(new Set());
  const previousErrorIds = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    const currentIds = new Set(errors.map((e) => e.id));
    const removedIds = [...previousErrorIds.current].filter((id) => !currentIds.has(id));
    if (removedIds.length > 0) {
      setDismissedIds((previous) => {
        const next = new Set(previous);
        for (const id of removedIds) {
          next.delete(id);
        }
        return next.size === previous.size ? previous : next;
      });
    }
    previousErrorIds.current = currentIds;
  }, [errors]);

  if (errors.length === 0) {
    return <></>;
  }

  const visibleErrors = errors.filter((e) => !dismissedIds.has(e.id));

  function handleDismiss(id: string): void {
    setDismissedIds((previous) => new Set(previous).add(id));
  }

  return (
    <div
      data-testid="budget-messages"
      className={cn('flex flex-col gap-2', className)}
      role="region"
      aria-live="polite"
    >
      <AnimatePresence>
        {visibleErrors.map((error) => {
          const Icon = getIcon(error.type);
          const canDismiss = isDismissible(error.type);
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
                <span className="flex-1">{renderMessageContent(error)}</span>
                {canDismiss && (
                  <IconButton
                    data-testid={`budget-dismiss-${error.id}`}
                    aria-label="Dismiss notification"
                    onClick={() => {
                      handleDismiss(error.id);
                    }}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </IconButton>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
