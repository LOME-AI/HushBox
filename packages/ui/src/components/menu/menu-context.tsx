'use client';

import * as React from 'react';

/** Anchored to the trigger, or a bottom sheet holding the same menu. */
export type MenuPresentation = 'anchored' | 'sheet';

interface MenuContextValue {
  presentation: MenuPresentation;
  /** Closes the menu after a sheet item is chosen; an anchored item closes through Radix. */
  close: () => void;
}

const MenuContext = React.createContext<MenuContextValue | null>(null);

function useMenuContext(): MenuContextValue {
  const context = React.useContext(MenuContext);
  if (context === null) throw new Error('A menu part renders only inside a Menu');
  return context;
}

interface MenuRadioContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

/** The group a radio item reports its value to, in either presentation. */
const MenuRadioContext = React.createContext<MenuRadioContextValue | null>(null);

function useMenuRadioContext(): MenuRadioContextValue {
  const context = React.useContext(MenuRadioContext);
  if (context === null) throw new Error('A MenuRadioItem renders only inside a MenuRadioGroup');
  return context;
}

/**
 * Holds an item's action until the menu has finished closing and returned focus, so an action
 * that moves focus, such as opening a pane, is not undone by the menu's own focus handling.
 */
const MenuAfterCloseContext = React.createContext<((action: () => void) => void) | null>(null);

function runNow(action: () => void): void {
  action();
}

/** How an item runs its action: at once, or held by its menu until the menu has closed. */
function useMenuActionTiming(runAfterClose: boolean): (action: () => void) => void {
  const hold = React.useContext(MenuAfterCloseContext);
  if (!runAfterClose) return runNow;
  if (hold === null) {
    throw new Error('An item that runs after its menu closes renders only inside a Menu');
  }
  return hold;
}

export {
  MenuAfterCloseContext,
  MenuContext,
  MenuRadioContext,
  useMenuActionTiming,
  useMenuContext,
  useMenuRadioContext,
};
