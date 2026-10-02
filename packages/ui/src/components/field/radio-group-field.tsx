import * as React from 'react';

import { RadioGroup, RadioGroupItem } from '../primitives/radio-group';
import { ChoiceLabel } from './choice-label';

interface RadioOption<V extends string> {
  value: V;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

interface RadioGroupFieldProps<V extends string> {
  legend: string;
  value: V;
  onValueChange: (value: V) => void;
  options: readonly RadioOption<V>[];
}

/**
 * A fieldset of radios under its legend, one row per option, each radio centred on
 * the whole label block of its option.
 */
function RadioGroupField<V extends string>({
  legend,
  value,
  onValueChange,
  options,
}: Readonly<RadioGroupFieldProps<V>>): React.JSX.Element {
  const groupId = React.useId();
  const legendId = `${groupId}-legend`;
  return (
    <fieldset className="min-w-0">
      <legend id={legendId} className="text-foreground mb-3 text-sm font-medium">
        {legend}
      </legend>
      <RadioGroup
        aria-labelledby={legendId}
        value={value}
        onValueChange={(next) => {
          // Reports the option's own value, so the callback receives a V without a cast.
          for (const option of options) if (option.value === next) onValueChange(option.value);
        }}
      >
        {options.map((option) => (
          <RadioRow key={option.value} groupId={groupId} option={option} />
        ))}
      </RadioGroup>
    </fieldset>
  );
}

function RadioRow<V extends string>({
  groupId,
  option,
}: Readonly<{ groupId: string; option: RadioOption<V> }>): React.JSX.Element {
  const controlId = `${groupId}-${option.value}`;
  const descriptionId = `${controlId}-description`;
  const hasDescription = option.description !== undefined;
  const disabled = option.disabled === true;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <RadioGroupItem
        id={controlId}
        value={option.value}
        disabled={disabled}
        {...(hasDescription && { 'aria-describedby': descriptionId })}
        className="border-border-control"
      />
      <ChoiceLabel
        htmlFor={controlId}
        label={option.label}
        description={option.description}
        descriptionId={descriptionId}
        disabled={disabled}
      />
    </div>
  );
}

export { RadioGroupField };
