import * as React from 'react';
import { cn } from '@hushbox/ui';
import { Icon, type IconComponent } from '@hushbox/ui/icons';

type ChipProps = React.ComponentProps<'button'> & {
  pressed?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  icon?: IconComponent;
  iconOnly?: boolean;
  label?: string;
  children?: React.ReactNode;
};

/**
 * Each state's look is keyed off the ARIA attribute that announces it, so the look and
 * what assistive tech hears cannot disagree. The transition names its properties so the
 * base layer's focus outline appears at once. On a coarse pointer a pseudo-element
 * reaches past the 2rem box to a 2.75rem target, so the composer row keeps its height;
 * it is placed from the padding box, so its vertical reach adds the 1px border back.
 */
const CHIP_CLASS =
  'relative inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border-control bg-transparent px-2.5 font-sans text-ui-sm font-medium leading-none whitespace-nowrap text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:bg-accent hover:text-foreground aria-pressed:border-brand-red aria-pressed:bg-brand-red-subtle aria-pressed:font-semibold aria-pressed:text-foreground aria-expanded:border-muted-foreground aria-expanded:bg-accent aria-expanded:text-foreground aria-disabled:cursor-not-allowed aria-disabled:border-dashed aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground pointer-coarse:before:absolute pointer-coarse:before:-inset-x-0.5 pointer-coarse:before:-inset-y-[calc(0.375rem+1px)]';

/** A composer control: a pill that toggles, opens a menu, or stands disabled. */
export function Chip({
  pressed,
  disabled = false,
  expanded,
  icon,
  iconOnly = false,
  label,
  children,
  className,
  onClick,
  'aria-label': ariaLabel,
  ...props
}: Readonly<ChipProps>): React.JSX.Element {
  // An aria-disabled button stays focusable, so a reader can still reach it and hear why.
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (!disabled) onClick?.(event);
  };
  return (
    <button
      type="button"
      {...props}
      aria-label={ariaLabel ?? (iconOnly ? label : undefined)}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-disabled={disabled ? true : undefined}
      onClick={handleClick}
      className={cn(CHIP_CLASS, iconOnly && 'w-8 justify-center px-0', className)}
    >
      {icon === undefined ? null : (
        <Icon icon={icon} className="[[aria-pressed=true]>&]:text-brand-red" />
      )}
      {label === undefined || iconOnly ? null : <span>{label}</span>}
      {children}
    </button>
  );
}
