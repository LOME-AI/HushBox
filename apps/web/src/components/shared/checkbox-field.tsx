import * as React from 'react';
import { Checkbox } from '@hushbox/ui';

interface CheckboxFieldProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string | undefined;
  testId?: string | undefined;
}

export function CheckboxField({
  id,
  checked,
  onCheckedChange,
  label,
  description,
  testId,
}: Readonly<CheckboxFieldProps>): React.JSX.Element {
  return (
    <div
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className="flex items-center gap-2"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(val) => {
          onCheckedChange(val === true);
        }}
        className="-mt-px size-6"
      />
      <div>
        <label htmlFor={id} className="text-muted-foreground cursor-pointer text-sm select-none">
          {label}
        </label>
        {description !== undefined && (
          <p className="text-muted-foreground text-xs">{description}</p>
        )}
      </div>
    </div>
  );
}
