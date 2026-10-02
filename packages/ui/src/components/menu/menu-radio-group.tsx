'use client';

import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { MenuRadioContext, useMenuContext } from './menu-context';

interface MenuRadioGroupProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  /** Names the group. */
  label?: string;
  children: React.ReactNode;
}

/** A set of `MenuRadioItem`s of which one is chosen, in either presentation. */
export function MenuRadioGroup<V extends string>({
  value,
  onValueChange,
  label,
  children,
}: Readonly<MenuRadioGroupProps<V>>): React.JSX.Element {
  const { presentation } = useMenuContext();
  const group = React.useMemo(
    () => ({
      value,
      // Only a `MenuRadioItem<V>` in this group reports a value, and it reports its own.
      onValueChange: (chosen: string) => {
        onValueChange(chosen as V);
      },
    }),
    [value, onValueChange]
  );
  const named = label === undefined ? {} : { 'aria-label': label };

  return (
    <MenuRadioContext value={group}>
      {presentation === 'sheet' ? (
        <div role="group" {...named}>
          {children}
        </div>
      ) : (
        <DropdownMenuPrimitive.RadioGroup value={value} {...named}>
          {children}
        </DropdownMenuPrimitive.RadioGroup>
      )}
    </MenuRadioContext>
  );
}
