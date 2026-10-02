'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { anchoredItemProps } from './menu-anchored-item';
import { useMenuActionTiming, useMenuContext } from './menu-context';
import {
  MenuItemBody,
  menuItemAria,
  menuItemClass,
  menuLinkTarget,
  useMenuItemIds,
  type MenuItemLink,
  type MenuItemLook,
} from './menu-item-body';
import { MenuSheetItem } from './menu-sheet-item';
import type * as React from 'react';

/** An item runs its caller's choice, or is a link that may also run one as it is followed. */
type MenuItemAction =
  | {
      /** Set, the item is a `menuitemcheckbox` that shows a check while true. */
      checked?: boolean;
      onSelect: () => void;
      href?: never;
      external?: never;
    }
  | (MenuItemLink & { onSelect?: () => void; checked?: never });

type MenuItemProps = MenuItemLook &
  MenuItemAction & {
    /** Placed on the element that carries the item's role, in both presentations. */
    'data-testid'?: string;
    /**
     * Holds the action until the menu has finished closing and returned focus to its trigger. An
     * action that moves focus elsewhere, such as opening a pane, needs it: run at once, the open
     * menu pulls focus back, and the close then returns it to the trigger.
     */
    runAfterClose?: boolean;
  };

/** One choice in a `Menu`, drawn the same whether the menu is anchored or a sheet. */
export function MenuItem({
  checked,
  onSelect,
  href,
  external,
  'data-testid': testId,
  runAfterClose = false,
  ...look
}: Readonly<MenuItemProps>): React.JSX.Element {
  const { presentation, close } = useMenuContext();
  const ids = useMenuItemIds();
  const checkable = checked !== undefined;
  const className = menuItemClass(look, presentation);
  const aria = menuItemAria(look, ids);
  const disabled = look.disabled === true;
  const body = <MenuItemBody {...look} checkable={checkable} ids={ids} />;
  const testIdProps = testId === undefined ? {} : { 'data-testid': testId };
  const link = href === undefined ? undefined : { href, external };
  const timeAction = useMenuActionTiming(runAfterClose);
  const choose = (): void => {
    timeAction(() => {
      onSelect?.();
    });
  };

  if (presentation === 'sheet') {
    return (
      <MenuSheetItem
        role={checkable ? 'menuitemcheckbox' : 'menuitem'}
        {...(checkable && { checked })}
        {...(link !== undefined && { link })}
        disabled={disabled}
        aria={aria}
        className={className}
        {...testIdProps}
        onChoose={() => {
          choose();
          close();
        }}
      >
        {body}
      </MenuSheetItem>
    );
  }

  const itemProps = { ...anchoredItemProps(className, aria, disabled, choose), ...testIdProps };
  if (link !== undefined) {
    return (
      <DropdownMenuPrimitive.Item asChild {...itemProps}>
        <a {...menuLinkTarget(link, disabled)}>{body}</a>
      </DropdownMenuPrimitive.Item>
    );
  }
  return checkable ? (
    <DropdownMenuPrimitive.CheckboxItem checked={checked} {...itemProps}>
      {body}
    </DropdownMenuPrimitive.CheckboxItem>
  ) : (
    <DropdownMenuPrimitive.Item {...itemProps}>{body}</DropdownMenuPrimitive.Item>
  );
}

export type { MenuItemProps };
