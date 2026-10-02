'use client';

import * as React from 'react';

import { Overlay } from '../overlay/overlay';
import { MENU_TRIGGER_ID_ATTRIBUTE, useOverlayFocusReturn } from '../overlay/overlay-focus-return';
import { SheetHead } from '../overlay/sheet-head';
import { MenuSheetList, type MenuEntry } from './menu-sheet-list';

interface MenuSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs once the sheet has finished closing and returned focus. */
  onClosed: () => void;
  title: string;
  header: 'title' | 'none';
  entry: MenuEntry;
  'data-testid'?: string | undefined;
  children: React.ReactNode;
}

/**
 * The id of the element holding focus as the sheet opens, which is its trigger: the menu focuses
 * the trigger before it opens a sheet. It lets a dialog an item opens return focus to that
 * trigger once the sheet and the item have left the page, as the anchored menu's `aria-labelledby`
 * does, while the sheet's list stays named by its title.
 */
function useOpenerId(open: boolean): string | undefined {
  const [openerId, setOpenerId] = React.useState<string>();
  React.useLayoutEffect(() => {
    if (!open) return;
    const id = document.activeElement?.id;
    setOpenerId(id === undefined || id === '' ? undefined : id);
  }, [open]);
  return openerId;
}

/**
 * A menu presented as the overlay's bottom sheet, with its handle and scrim, the shared sheet head
 * (title and close) unless `header` is `none`, and the menu. Named by the title whether or not
 * the head shows.
 */
export function MenuSheet({
  open,
  onOpenChange,
  onClosed,
  title,
  header,
  entry,
  'data-testid': testId,
  children,
}: Readonly<MenuSheetProps>): React.JSX.Element {
  const triggerId = useOpenerId(open);
  const returnFocus = useOverlayFocusReturn(open);
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={title}
      showCloseButton={false}
      onCloseAutoFocus={(event) => {
        returnFocus(event);
        onClosed();
      }}
    >
      <div
        className="flex min-h-0 flex-col px-2 pb-3"
        {...(triggerId !== undefined && { [MENU_TRIGGER_ID_ATTRIBUTE]: triggerId })}
      >
        {header === 'title' && (
          <div className="pb-2 pl-2">
            <SheetHead
              title={title}
              onClose={() => {
                onOpenChange(false);
              }}
            />
          </div>
        )}
        <MenuSheetList title={title} entry={entry} data-testid={testId}>
          {children}
        </MenuSheetList>
      </div>
    </Overlay>
  );
}
