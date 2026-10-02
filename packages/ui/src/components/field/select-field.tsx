import * as React from 'react';

import { cn } from '../../lib/utilities';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../primitives/select';
import { FieldMessage } from './field-message';
import { LABELLED_FIELD_CLASSES } from './labelled-field-classes';

interface SelectOption<V extends string> {
  value: V;
  label: React.ReactNode;
}

interface SelectFieldProps<V extends string> {
  /** The trigger's id; the help and message ids are named after it. */
  id?: string;
  label: string;
  /** Keeps the label for assistive technology and hides it from view. */
  labelHidden?: boolean;
  triggerTestId?: string;
  /** The trigger's text while no value is chosen. */
  placeholder?: string;
  /**
   * Shown in the trigger in place of the chosen item's label; the list keeps every full label.
   * A function instead receives the field's own value, the chosen label, and places it inside
   * whatever frames it: the list opens aligned to that value, so a frame wider than the label
   * does not pull the list off it.
   */
  triggerText?: React.ReactNode | ((value: React.ReactNode) => React.ReactNode);
  /** `sm` draws the trigger at the compact control height of a dense row. */
  size?: 'sm';
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  help?: string;
  error?: string;
  /** Set as the test id on the error line. */
  errorTestId?: string;
  disabled?: boolean;
}

interface TriggerAttributes {
  id: string;
  'data-testid'?: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

/** The trigger's ids: each description and state attribute only while it applies. */
function triggerAttributes({
  controlId,
  triggerTestId,
  helpId,
  messageId,
}: Readonly<{
  controlId: string;
  triggerTestId: string | undefined;
  helpId: string | undefined;
  messageId: string | undefined;
}>): TriggerAttributes {
  const describedBy = [helpId, messageId].filter(Boolean).join(' ');
  return {
    id: controlId,
    ...(triggerTestId !== undefined && { 'data-testid': triggerTestId }),
    ...(messageId !== undefined && { 'aria-invalid': true }),
    ...(describedBy !== '' && { 'aria-describedby': describedBy }),
  };
}

/** The trigger's value: the chosen label, or the trigger text, placed as the caller asks. */
function triggerValue(
  placeholder: string | undefined,
  triggerText: SelectFieldProps<string>['triggerText']
): React.JSX.Element {
  const placeholderProps = placeholder === undefined ? {} : { placeholder };
  if (typeof triggerText === 'function') {
    return <>{triggerText(<SelectValue {...placeholderProps} />)}</>;
  }
  return <SelectValue {...placeholderProps}>{triggerText}</SelectValue>;
}

/** A labelled select: the label above, help and error below, on the control border. */
function SelectField<V extends string>({
  id,
  label,
  labelHidden = false,
  triggerTestId,
  placeholder,
  triggerText,
  size,
  value,
  onValueChange,
  options,
  help,
  error,
  errorTestId,
  disabled = false,
}: Readonly<SelectFieldProps<V>>): React.JSX.Element {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const helpId = `${controlId}-help`;
  const messageId = `${controlId}-message`;
  const trigger = triggerAttributes({
    controlId,
    triggerTestId,
    helpId: help === undefined ? undefined : helpId,
    messageId: error ? messageId : undefined,
  });
  return (
    <div className={LABELLED_FIELD_CLASSES.stack}>
      <label
        htmlFor={controlId}
        className={cn(LABELLED_FIELD_CLASSES.label, labelHidden && 'sr-only')}
      >
        {label}
      </label>
      <div className={LABELLED_FIELD_CLASSES.control}>
        <Select
          value={value}
          disabled={disabled}
          onValueChange={(next) => {
            // Reports the option's own value, so the callback receives a V without a cast.
            for (const option of options) if (option.value === next) onValueChange(option.value);
          }}
        >
          <SelectTrigger
            {...trigger}
            {...(size !== undefined && { size })}
            className="border-border-control w-full pointer-coarse:min-h-11"
          >
            {triggerValue(placeholder, triggerText)}
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {help !== undefined && (
          <p id={helpId} className={LABELLED_FIELD_CLASSES.help}>
            {help}
          </p>
        )}
        <FieldMessage id={messageId} error={error} errorTestId={errorTestId} />
      </div>
    </div>
  );
}

export { SelectField };
