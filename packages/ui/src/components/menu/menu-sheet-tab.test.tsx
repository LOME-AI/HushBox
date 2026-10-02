import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Menu, type MenuProps } from './menu';
import { MenuContext } from './menu-context';
import { MenuItem } from './menu-item';
import { MenuSheetList } from './menu-sheet-list';
import { PHONE, installViewport, restoreViewport } from './menu-viewport.setup';

afterEach(() => {
  restoreViewport();
});

function SheetMenu(props: Readonly<Partial<MenuProps>>): React.JSX.Element {
  return (
    <>
      <Menu trigger={<button type="button">More</button>} title="More options" {...props}>
        <MenuItem title="Settings" onSelect={vi.fn()} />
        <MenuItem title="Usage" onSelect={vi.fn()} />
      </Menu>
      <button type="button">Behind the sheet</button>
    </>
  );
}

async function openOnFirstItem(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });
  return user;
}

function sheetClose(): HTMLElement {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });
}

describe('Tab in the menu sheet', () => {
  it('moves from an item to the close', async () => {
    installViewport(PHONE);
    render(<SheetMenu />);
    const user = await openOnFirstItem();

    await user.tab();

    expect(sheetClose()).toHaveFocus();
  });

  it('moves back from an item to the close on Shift+Tab', async () => {
    installViewport(PHONE);
    render(<SheetMenu />);
    const user = await openOnFirstItem();

    await user.tab({ shift: true });

    expect(sheetClose()).toHaveFocus();
  });

  it('moves from the close back into the menu', async () => {
    installViewport(PHONE);
    render(<SheetMenu />);
    const user = await openOnFirstItem();
    await user.tab();

    await user.tab();

    expect(screen.getByRole('menu')).toHaveFocus();
  });

  it('wraps from the menu back to the close', async () => {
    installViewport(PHONE);
    render(<SheetMenu />);
    const user = await openOnFirstItem();
    await user.tab();
    await user.tab();

    await user.tab();

    expect(sheetClose()).toHaveFocus();
  });

  it('keeps focus on the item when the sheet has no close', async () => {
    installViewport(PHONE);
    render(<SheetMenu sheetHeader="none" />);
    const user = await openOnFirstItem();

    await user.tab();

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('closes the sheet from the close in its head', async () => {
    installViewport(PHONE);
    render(<SheetMenu />);
    await openOnFirstItem();

    fireEvent.click(sheetClose());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More', hidden: true })).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });
  });
});

describe('a sheet menu list outside a sheet', () => {
  it('holds focus on the item on Tab, with no close to move to', async () => {
    render(
      <MenuContext value={{ presentation: 'sheet', close: vi.fn() }}>
        <MenuSheetList title="Loose" entry="keyboard">
          <MenuItem title="Settings" onSelect={vi.fn()} />
        </MenuSheetList>
        <button type="button">After</button>
      </MenuContext>
    );
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    });

    await userEvent.setup().tab();

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });
});
