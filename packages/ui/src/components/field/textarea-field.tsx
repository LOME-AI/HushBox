import * as React from 'react';

import { cn } from '../../lib/utilities';
import { Presence } from '../motion/presence';
import { Textarea } from '../primitives/textarea';
import { FieldMessage } from './field-message';

interface TextareaCount {
  value: number;
  max: number;
}

type TextareaFieldProps = Omit<React.ComponentProps<'textarea'>, 'maxLength'> & {
  label: string;
  /** Keeps the label for assistive technology and hides it from view. */
  labelHidden?: boolean;
  optional?: boolean;
  help?: string;
  error?: string;
  count?: TextareaCount;
};

interface FootIds {
  help: string;
  count: string;
  notice: string;
}

/**
 * The row under the textarea: the help line, and with a count, the count at the row's
 * end and the over-limit notice. The notice's live region is always present, so the
 * notice is announced when it enters rather than when the region does.
 */
function TextareaFoot({
  ids,
  help,
  count,
}: Readonly<{ ids: FootIds; help: string | undefined; count: TextareaCount | undefined }>):
  | React.JSX.Element
  | undefined {
  if (help === undefined && count === undefined) return undefined;
  const isOver = count !== undefined && count.value > count.max;
  return (
    <div className="mt-2 flex items-baseline justify-between gap-4 text-xs">
      <div className="flex min-w-0 flex-col gap-1">
        {help !== undefined && (
          <p id={ids.help} className="text-muted-foreground">
            {help}
          </p>
        )}
        {count !== undefined && (
          <div id={ids.notice} aria-live="polite" className="text-destructive">
            <Presence initial={false}>
              {isOver && (
                <p key="notice">
                  Only the first {count.max.toLocaleString()} characters will be used.
                </p>
              )}
            </Presence>
          </div>
        )}
      </div>
      {count !== undefined && (
        <p
          id={ids.count}
          className={cn(
            'shrink-0 tabular-nums',
            isOver ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {count.value.toLocaleString()} / {count.max.toLocaleString()}
        </p>
      )}
    </div>
  );
}

interface DescribedByInput {
  callerDescribedBy: string | undefined;
  ids: FootIds;
  messageId: string;
  hasHelp: boolean;
  hasCount: boolean;
  isOver: boolean;
  hasError: boolean;
}

function describedByIds({
  callerDescribedBy,
  ids,
  messageId,
  hasHelp,
  hasCount,
  isOver,
  hasError,
}: DescribedByInput): string {
  return [
    callerDescribedBy,
    hasHelp ? ids.help : undefined,
    hasCount ? ids.count : undefined,
    isOver ? ids.notice : undefined,
    hasError ? messageId : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * A labelled textarea: the label above, help and error below. With `count` it shows
 * "value / max" under the field. The limit is soft: typing is never blocked, and over
 * it the count and the field turn destructive and a polite notice says what will be
 * used. Callers truncate to `max` on submit.
 */
function TextareaField({
  label,
  labelHidden = false,
  optional = false,
  help,
  error,
  count,
  id,
  className,
  'aria-describedby': callerDescribedBy,
  'aria-invalid': callerInvalid,
  ...native
}: Readonly<TextareaFieldProps>): React.JSX.Element {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const ids = {
    help: `${controlId}-help`,
    count: `${controlId}-count`,
    notice: `${controlId}-notice`,
  };
  const messageId = `${controlId}-message`;
  const hasError = Boolean(error);
  const isOver = count !== undefined && count.value > count.max;
  const describedBy = describedByIds({
    callerDescribedBy,
    ids,
    messageId,
    hasHelp: help !== undefined,
    hasCount: count !== undefined,
    isOver,
    hasError,
  });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label
        htmlFor={controlId}
        className={cn('text-foreground text-sm font-medium', labelHidden && 'sr-only')}
      >
        {label}
        {optional && <span className="text-muted-foreground font-normal"> (optional)</span>}
      </label>
      <div className="flex min-w-0 flex-col">
        <Textarea
          {...native}
          id={controlId}
          aria-invalid={hasError || isOver ? true : callerInvalid}
          {...(describedBy !== '' && { 'aria-describedby': describedBy })}
          className={cn('border-border-control focus-visible:outline-solid', className)}
        />
        <TextareaFoot ids={ids} help={help} count={count} />
        <FieldMessage id={messageId} error={error} />
      </div>
    </div>
  );
}

export { TextareaField };
