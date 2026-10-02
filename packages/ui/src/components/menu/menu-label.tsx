'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { useMenuContext } from './menu-context';
import type * as React from 'react';

const LABEL_CLASS = 'px-2 py-1.5 text-sm font-medium';

/** A heading line inside the menu, above the items it introduces. */
export function MenuLabel({
  'data-testid': testId,
  children,
}: Readonly<{ 'data-testid'?: string; children: React.ReactNode }>): React.JSX.Element {
  const { presentation } = useMenuContext();
  const testIdProps = testId === undefined ? {} : { 'data-testid': testId };
  return presentation === 'sheet' ? (
    <div className={LABEL_CLASS} {...testIdProps}>
      {children}
    </div>
  ) : (
    <DropdownMenuPrimitive.Label className={LABEL_CLASS} {...testIdProps}>
      {children}
    </DropdownMenuPrimitive.Label>
  );
}
