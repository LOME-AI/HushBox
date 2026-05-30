import * as React from 'react';

export interface InlineFormErrorProps {
  /** Error message to display, or null to render nothing. */
  error: string | null;
  /**
   * Monotonic counter bumped each time a new error is produced. Used as
   * React's `key` so consecutive identical errors still remount the element
   * — that retriggers the shake animation. Pair with `useAsyncAction`,
   * which manages this counter automatically.
   */
  errorKey: number;
  /**
   * Optional id placed on the rendered element. Use to link an input to its
   * error message via `aria-describedby` for assistive-tech announcements.
   */
  id?: string;
}

/**
 * Generic inline error region for forms and modal actions. Renders below the
 * relevant control with a shake animation to draw attention without stealing
 * focus. Reduced-motion users get a static element (handled by
 * `html.reduced-motion .animate-shake` in app.css).
 */
export function InlineFormError({
  error,
  errorKey,
  id,
}: Readonly<InlineFormErrorProps>): React.JSX.Element | null {
  if (!error) return null;

  return (
    <p
      key={errorKey}
      role="alert"
      className="text-destructive animate-shake text-center text-sm"
      {...(id !== undefined && { id })}
    >
      {error}
    </p>
  );
}
