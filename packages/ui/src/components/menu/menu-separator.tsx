'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { useMenuContext } from './menu-context';
import type * as React from 'react';

const SEPARATOR_CLASS = 'bg-border -mx-1 my-1 h-px shrink-0';

/** A hairline between groups of items, reaching the menu's edges. */
export function MenuSeparator(): React.JSX.Element {
  const { presentation } = useMenuContext();
  return presentation === 'sheet' ? (
    <div role="separator" aria-orientation="horizontal" className={SEPARATOR_CLASS} />
  ) : (
    <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />
  );
}
