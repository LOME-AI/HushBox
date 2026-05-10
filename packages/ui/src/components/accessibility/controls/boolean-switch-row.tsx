import * as React from 'react';

import { Switch } from '../../switch';

export interface BooleanSwitchRowProps {
  label: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}

/**
 * Labelled on/off row used throughout the accessibility panel sections.
 * The label wraps the Switch so a click anywhere on the row toggles the
 * state — Radix Switch handles the keyboard semantics.
 */
export function BooleanSwitchRow({
  label,
  checked,
  onCheckedChange,
}: Readonly<BooleanSwitchRowProps>): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
      <span>{label}</span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
