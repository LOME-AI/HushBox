import * as React from 'react';

import { cn } from '../../lib/utilities';
import { Switch } from '../primitives/switch';
import { FieldMessage } from './field-message';

interface SwitchFieldProps {
  id?: string;
  testId?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  /** Draws the label and description at a settings row's title and description sizes. */
  settingsRow?: boolean;
  /** Draws an error row under the switch row and marks the switch invalid. */
  error?: string;
  /** Set as the test id on the error line. */
  errorTestId?: string;
}

interface TextClasses {
  block: string;
  label: string;
  description: string;
}

const FIELD_TEXT: TextClasses = { block: 'gap-1', label: 'text-sm', description: 'text-sm' };

/** The kit settings row's title and description sizes and the gap between them. */
const SETTINGS_ROW_TEXT: TextClasses = {
  block: 'gap-0.5',
  label: 'text-ui',
  description: 'text-ui-sm',
};

interface SwitchAttributes {
  'data-testid'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/** The switch's test id, description and state attributes, each only while it applies. */
function switchAttributes({
  testId,
  descriptionId,
  messageId,
}: Readonly<{
  testId: string | undefined;
  descriptionId: string | undefined;
  messageId: string | undefined;
}>): SwitchAttributes {
  const describedBy = [descriptionId, messageId].filter(Boolean).join(' ');
  return {
    ...(testId !== undefined && { 'data-testid': testId }),
    ...(describedBy !== '' && { 'aria-describedby': describedBy }),
    ...(messageId !== undefined && { 'aria-invalid': true }),
  };
}

/** The row alone, or the row over its error line while it holds an error. */
function ErrorFrame({
  messageId,
  error,
  errorTestId,
  children,
}: Readonly<{
  messageId: string;
  error: string | undefined;
  errorTestId: string | undefined;
  children: React.JSX.Element;
}>): React.JSX.Element {
  if (!error) return children;
  return (
    <div className="flex min-w-0 flex-col">
      {children}
      <FieldMessage id={messageId} error={error} errorTestId={errorTestId} />
    </div>
  );
}

/**
 * A setting row: the label block first and the switch at the row's end, centred on
 * the whole block. Every drawn switch sits at the end, so the row takes no position.
 */
function SwitchField({
  id,
  testId,
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  settingsRow = false,
  error,
  errorTestId,
}: Readonly<SwitchFieldProps>): React.JSX.Element {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const descriptionId = `${controlId}-description`;
  const messageId = `${controlId}-message`;
  const hasDescription = description !== undefined;
  const attributes = switchAttributes({
    testId,
    descriptionId: hasDescription ? descriptionId : undefined,
    messageId: error ? messageId : undefined,
  });
  const text = settingsRow ? SETTINGS_ROW_TEXT : FIELD_TEXT;
  const row = (
    <div className="flex min-w-0 items-center justify-between gap-4">
      <div className={cn('flex min-w-0 flex-col', text.block, disabled && 'opacity-50')}>
        <label
          htmlFor={controlId}
          className={cn(
            'text-foreground font-medium select-none',
            text.label,
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          )}
        >
          {label}
        </label>
        {hasDescription && (
          <p id={descriptionId} className={cn('text-muted-foreground', text.description)}>
            {description}
          </p>
        )}
      </div>
      <Switch
        id={controlId}
        {...attributes}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        // Names its properties so the base layer's focus outline appears at once;
        // the primitive's `transition-all` would morph it in.
        className="shrink-0 transition-[color,background-color,border-color,box-shadow,opacity]"
      />
    </div>
  );
  return (
    <ErrorFrame messageId={messageId} error={error} errorTestId={errorTestId}>
      {row}
    </ErrorFrame>
  );
}

export { SwitchField };
