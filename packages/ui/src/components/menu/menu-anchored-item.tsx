import { keepFocusWhileClosing } from '../primitives/dropdown-menu';
import type * as React from 'react';

interface AnchoredItemProps {
  className: string;
  'aria-labelledby': string;
  'aria-describedby'?: string;
  'aria-disabled'?: true;
  onSelect: (event: Event) => void;
  onPointerMove: React.PointerEventHandler<HTMLDivElement>;
  onPointerLeave: React.PointerEventHandler<HTMLDivElement>;
}

/**
 * The props every anchored item hands its Radix item. A disabled item is `aria-disabled` rather
 * than Radix-disabled, so arrow keys still reach it and its reason, and its choice is refused
 * here: Radix's checkbox and radio items report a change even for a prevented selection.
 */
export function anchoredItemProps(
  className: string,
  aria: { 'aria-labelledby': string; 'aria-describedby'?: string },
  disabled: boolean,
  onChoose: () => void
): AnchoredItemProps {
  return {
    className,
    ...aria,
    ...(disabled && { 'aria-disabled': true as const }),
    onSelect: (event: Event) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onChoose();
    },
    onPointerMove: keepFocusWhileClosing(),
    onPointerLeave: keepFocusWhileClosing(),
  };
}
