import * as React from 'react';

import { cn } from '../../lib/utilities';
import { HIT_AREA_CLASSES } from '../button/icon-button';
import { Checkbox } from '../primitives/checkbox';
import { ChoiceLabel } from './choice-label';

interface CheckFieldProps {
  id?: string;
  testId?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  size?: 'md' | 'lg';
  disabled?: boolean;
}

/**
 * A checkbox beside its label. The row centres the box on the whole label block, one
 * line, a wrapped label or a title with its description, so no caller nudges it. On a
 * coarse pointer the row stands at least as tall as the box's 2.75rem target, so in a
 * stack of rows no target reaches over a neighbour's box.
 */
function CheckField({
  id,
  testId,
  checked,
  onCheckedChange,
  label,
  description,
  size = 'md',
  disabled = false,
}: Readonly<CheckFieldProps>): React.JSX.Element {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const descriptionId = `${controlId}-description`;
  const hasDescription = description !== undefined;
  return (
    <div className="flex min-w-0 items-center gap-2 pointer-coarse:min-h-11">
      <Checkbox
        id={controlId}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        {...(hasDescription && { 'aria-describedby': descriptionId })}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => {
          onCheckedChange(next === true);
        }}
        className={cn(HIT_AREA_CLASSES.extend, 'border-border-control', size === 'lg' && 'size-6')}
      />
      <ChoiceLabel
        htmlFor={controlId}
        label={label}
        description={description}
        descriptionId={descriptionId}
        disabled={disabled}
      />
    </div>
  );
}

export { CheckField };
