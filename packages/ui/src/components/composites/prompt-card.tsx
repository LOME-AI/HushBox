import * as React from 'react';

import { Button } from '../primitives/button';
import { cn } from '../../lib/utilities';

/**
 * One of the card's two answers: a label, what it does, and whether it is
 * mid-flight. An answer with no handler is one there is nothing to do with yet
 * — a Done before anything is chosen — and renders disabled, so a caller says
 * that by having no handler rather than by pairing a no-op with a flag.
 */
interface PromptAnswer {
  readonly label: string;
  readonly isBusy?: boolean | undefined;
}

/**
 * The chrome every one-at-a-time prompt wears: a status region, a heading, an
 * optional line under it, whatever the prompt itself puts in the middle, and
 * up to two answers side by side.
 *
 * A status region rather than a dialog, because a prompt is an offer and never
 * an interruption: it announces politely, takes no focus, and both answers are
 * ordinary buttons a keyboard reaches in reading order. It is sized for the
 * sidebar column it is mounted in and depends on no width wider than that.
 */
function PromptCard({
  heading,
  body,
  primary,
  secondary,
  className,
  children,
  ...props
}: Readonly<
  Omit<React.ComponentProps<'div'>, 'role'> & {
    heading: React.ReactNode;
    body?: React.ReactNode | undefined;
    primary?: (PromptAnswer & { onPrimary: (() => void) | undefined }) | undefined;
    secondary?: (PromptAnswer & { onSecondary: (() => void) | undefined }) | undefined;
  }
>): React.JSX.Element {
  const hasAnswers = primary !== undefined || secondary !== undefined;
  return (
    <div
      data-slot="prompt-card"
      role="status"
      className={cn(
        'border-sidebar-border bg-card mt-2 flex shrink-0 flex-col gap-2 rounded-lg border p-3',
        className
      )}
      {...props}
    >
      <h2 data-slot="prompt-card-heading" className="text-sm font-medium">
        {heading}
      </h2>
      {body !== undefined && (
        <p data-slot="prompt-card-body" className="text-muted-foreground text-xs leading-relaxed">
          {body}
        </p>
      )}
      {children}
      {hasAnswers && (
        <div data-slot="prompt-card-answers" className="flex gap-2">
          {primary !== undefined && (
            <Button
              size="sm"
              className="flex-1"
              onClick={primary.onPrimary}
              disabled={primary.isBusy === true || primary.onPrimary === undefined}
            >
              {primary.label}
            </Button>
          )}
          {secondary !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              className="flex-1"
              onClick={secondary.onSecondary}
              disabled={secondary.isBusy === true || secondary.onSecondary === undefined}
            >
              {secondary.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export { PromptCard };
