'use client';

import * as React from 'react';

import { useMenuTypeahead } from './menu-typeahead';

/** How the menu was opened: from the keyboard its first item takes focus, as Radix's menu does. */
export type MenuEntry = 'pointer' | 'keyboard';

// A disabled item stays reachable, so its reason is read; choosing it is refused.
const ITEM = '[role^="menuitem"]';

// Radix's menu moves to the first item on these keys and to the last on their partners.
const FIRST_KEYS = new Set(['Home', 'PageUp']);
const LAST_KEYS = new Set(['End', 'PageDown']);

function nextItem(
  items: readonly HTMLElement[],
  key: string,
  current: number
): HTMLElement | undefined {
  if (FIRST_KEYS.has(key)) return items[0];
  if (LAST_KEYS.has(key)) return items.at(-1);
  if (key === 'ArrowDown')
    return current === -1 ? items[0] : items[Math.min(current + 1, items.length - 1)];
  if (key === 'ArrowUp') return current === -1 ? items.at(-1) : items[Math.max(current - 1, 0)];
  return undefined;
}

/**
 * The sheet's tab stops are the menu and the head's close. An item is no tab stop, so Tab from one
 * would go on to whatever follows it in the page, past the sheet; it goes to the close instead, or
 * nowhere when the sheet has no head. Tab from the menu itself and from the close is the sheet's
 * focus scope's to wrap.
 */
function moveTabFromItem(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.target === event.currentTarget) return;
  event.preventDefault();
  // Handled here: the scope would otherwise read the close it now finds focused as its first stop
  // and wrap a Shift+Tab on past it.
  event.stopPropagation();
  event.currentTarget
    .closest('[role="dialog"]')
    ?.querySelector<HTMLElement>('[data-slot="overlay-close"]')
    ?.focus();
}

interface MenuSheetListProps {
  title: string;
  entry: MenuEntry;
  'data-testid'?: string | undefined;
  children: React.ReactNode;
}

/**
 * The menu inside a sheet: the same `menu` role, arrow-key movement and typed-letter search as
 * the anchored menu, with no wrap at either end.
 *
 * It takes focus as it mounts. The sheet's focus scope moves focus only when nothing inside it
 * holds focus yet, and this effect runs before the scope's, so the menu, not the sheet, holds it.
 */
export function MenuSheetList({
  title,
  entry,
  'data-testid': testId,
  children,
}: Readonly<MenuSheetListProps>): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement>(null);
  // Read once, as the sheet opens; a later entry belongs to a later open.
  const entryRef = React.useRef(entry);

  React.useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const first = entryRef.current === 'keyboard' ? list.querySelector<HTMLElement>(ITEM) : null;
    (first ?? list).focus({ preventScroll: true });
  }, []);

  const typeahead = useMenuTypeahead();

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      moveTabFromItem(event);
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)];
    const current = items.find((item) => item.contains(document.activeElement));
    if (typeahead(event, items, current)) {
      event.preventDefault();
      return;
    }
    const target = nextItem(items, event.key, current === undefined ? -1 : items.indexOf(current));
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div
      ref={listRef}
      role="menu"
      aria-orientation="vertical"
      aria-label={title}
      tabIndex={0}
      className="flex flex-col outline-none"
      {...(testId !== undefined && { 'data-testid': testId })}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}
