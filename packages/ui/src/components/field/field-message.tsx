import { cn } from '../../lib/utilities';
import type * as React from 'react';

interface FieldMessageProps {
  id: string;
  error?: string | undefined;
  success?: string | undefined;
  /** Keeps the top margin on the empty row: the floating-label field spaces by it, a plain field does not. */
  reserve?: boolean;
  /** Set as the test id on the error line, never on a success line. */
  errorTestId?: string | undefined;
}

/**
 * A field's message row: always present, so the control's `aria-describedby`
 * target exists before any message does. The error is a fresh `role="alert"`
 * element rather than a role toggled on the row, because inserting an alert is
 * what screen readers announce reliably.
 */
export function FieldMessage({
  id,
  error,
  success,
  reserve = false,
  errorTestId,
}: Readonly<FieldMessageProps>): React.JSX.Element {
  const hasMessage = Boolean(error) || Boolean(success);
  return (
    <div
      id={id}
      className={cn('text-xs', (hasMessage || reserve) && 'mt-1', hasMessage && 'min-h-5')}
    >
      {error ? (
        <p
          role="alert"
          className="text-destructive"
          {...(errorTestId !== undefined && { 'data-testid': errorTestId })}
        >
          {error}
        </p>
      ) : (
        success && <p className="text-success">{success}</p>
      )}
    </div>
  );
}
