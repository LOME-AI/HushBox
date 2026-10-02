'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { anchoredItemProps } from './menu-anchored-item';
import { useMenuContext, useMenuRadioContext } from './menu-context';
import {
  MenuItemBody,
  menuItemAria,
  menuItemClass,
  useMenuItemIds,
  type MenuItemLook,
} from './menu-item-body';
import { MenuSheetItem } from './menu-sheet-item';
import type * as React from 'react';

type MenuRadioItemProps<V extends string> = MenuItemLook & {
  value: V;
  /** Placed on the element that carries `menuitemradio`, in both presentations. */
  'data-testid'?: string;
};

/** One value of a `MenuRadioGroup`: a `menuitemradio`, checked while its group holds its value. */
export function MenuRadioItem<V extends string>({
  value,
  'data-testid': testId,
  ...look
}: Readonly<MenuRadioItemProps<V>>): React.JSX.Element {
  const { presentation, close } = useMenuContext();
  const group = useMenuRadioContext();
  const ids = useMenuItemIds();
  const className = menuItemClass(look, presentation);
  const aria = menuItemAria(look, ids);
  const disabled = look.disabled === true;
  const body = <MenuItemBody {...look} checkable ids={ids} />;
  const testIdProps = testId === undefined ? {} : { 'data-testid': testId };
  const choose = (): void => {
    group.onValueChange(value);
  };

  if (presentation === 'sheet') {
    return (
      <MenuSheetItem
        role="menuitemradio"
        checked={group.value === value}
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

  return (
    <DropdownMenuPrimitive.RadioItem
      value={value}
      {...anchoredItemProps(className, aria, disabled, choose)}
      {...testIdProps}
    >
      {body}
    </DropdownMenuPrimitive.RadioItem>
  );
}
