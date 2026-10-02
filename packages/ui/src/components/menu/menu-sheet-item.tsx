import { menuLinkTarget, type MenuItemLink } from './menu-item-body';
import type * as React from 'react';

interface MenuSheetItemProps {
  role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
  checked?: boolean;
  /** Set, the item is an anchor to it, chosen as it is followed. */
  link?: MenuItemLink;
  disabled: boolean;
  aria: { 'aria-labelledby': string; 'aria-describedby'?: string };
  className: string;
  'data-testid'?: string;
  /** Runs when the item is chosen; the sheet closes after it. */
  onChoose: () => void;
  children: React.ReactNode;
}

/**
 * Space chooses a menu item, as Radix's anchored item does, and an anchor has no Space of its own.
 * The sheet's list hears the key after the item and takes a space that continues a typed search,
 * so the choice waits for the list and gives way to it.
 */
function followOnSpace(event: React.KeyboardEvent<HTMLAnchorElement>): void {
  if (event.key !== ' ') return;
  const link = event.currentTarget;
  const key = event.nativeEvent;
  queueMicrotask(() => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    link.click();
  });
}

/**
 * A sheet's menu item. The sheet list moves focus between items with the arrow keys, so each
 * item stays out of the tab order, as Radix's anchored items do; Enter and Space choose it. A
 * disabled item keeps its focus and refuses the choice, as the anchored item does.
 */
export function MenuSheetItem({
  role,
  checked,
  link,
  disabled,
  aria,
  className,
  'data-testid': testId,
  onChoose,
  children,
}: Readonly<MenuSheetItemProps>): React.JSX.Element {
  const choose = (): void => {
    if (!disabled) onChoose();
  };
  const shared = {
    tabIndex: -1,
    className,
    ...aria,
    ...(testId !== undefined && { 'data-testid': testId }),
    ...(checked !== undefined && { 'aria-checked': checked }),
    ...(disabled && { 'aria-disabled': true }),
  };

  if (link !== undefined) {
    return (
      <a
        role={role}
        {...shared}
        {...menuLinkTarget(link, disabled)}
        onClick={choose}
        onKeyDown={followOnSpace}
      >
        {children}
      </a>
    );
  }

  return (
    <button type="button" role={role} {...shared} onClick={choose}>
      {children}
    </button>
  );
}
