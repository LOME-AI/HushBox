import { cn } from '../../lib/utilities';
import type * as React from 'react';

interface ChoiceLabelProps {
  htmlFor: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  /** The id the control's `aria-describedby` names; required only with a description. */
  descriptionId?: string;
  disabled: boolean;
}

/**
 * The text block beside a checkbox or a radio: the label, and under it the description.
 * The kit draws both as one look, so both fields render this block.
 */
function ChoiceLabel({
  htmlFor,
  label,
  description,
  descriptionId,
  disabled,
}: Readonly<ChoiceLabelProps>): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col', disabled && 'opacity-50')}>
      <label
        htmlFor={htmlFor}
        className={cn(
          'text-muted-foreground text-sm select-none',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        )}
      >
        {label}
      </label>
      {description !== undefined && (
        <p id={descriptionId} className="text-muted-foreground text-xs">
          {description}
        </p>
      )}
    </div>
  );
}

export { ChoiceLabel };
