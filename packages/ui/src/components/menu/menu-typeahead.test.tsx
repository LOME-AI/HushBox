import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Menu } from './menu';
import { MenuItem } from './menu-item';
import { DESKTOP, PHONE, installViewport, restoreViewport } from './menu-viewport.setup';

afterEach(() => {
  restoreViewport();
});

/** Past the one second a typed search holds in both presentations. */
const SEARCH_LAPSE_MS = 1100;

function AccountMenu(): React.JSX.Element {
  return (
    <Menu trigger={<button type="button">Account</button>} title="Account">
      <MenuItem title="Settings" onSelect={vi.fn()} />
      <MenuItem title="Security" onSelect={vi.fn()} />
      <MenuItem title="Usage" onSelect={vi.fn()} />
      <MenuItem title="Support" onSelect={vi.fn()} />
    </Menu>
  );
}

async function openFromKeyboard(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  await waitFor(() => {
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });
  return user;
}

describe.each([
  ['a sheet', PHONE],
  ['an anchored menu', DESKTOP],
])('Menu typeahead in %s', (_presentation, width) => {
  it('moves to the item whose title starts with the typed letter', async () => {
    installViewport(width);
    render(<AccountMenu />);
    const user = await openFromKeyboard();

    await user.keyboard('u');

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Usage' })).toHaveFocus();
    });
  });

  it('moves on to the next match when the same letter is typed again', async () => {
    installViewport(width);
    render(<AccountMenu />);
    const user = await openFromKeyboard();

    await user.keyboard('ss');

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Support' })).toHaveFocus();
    });
  });

  it('narrows the match as letters are typed', async () => {
    installViewport(width);
    render(<AccountMenu />);
    const user = await openFromKeyboard();

    await user.keyboard('su');

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Support' })).toHaveFocus();
    });
  });

  it('leaves focus where it is when nothing matches', async () => {
    installViewport(width);
    render(<AccountMenu />);
    const user = await openFromKeyboard();

    await user.keyboard('z');

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('searches from the first item when the menu itself holds focus', async () => {
    installViewport(width);
    render(<AccountMenu />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await waitFor(() => {
      expect(screen.getByRole('menu')).toHaveFocus();
    });

    await user.keyboard('s');

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    });
  });

  it('ignores a letter typed with a modifier held', async () => {
    installViewport(width);
    render(<AccountMenu />);
    const user = await openFromKeyboard();

    await user.keyboard('{Control>}u{/Control}');

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('starts a new search once the typed one has lapsed', async () => {
    installViewport(width);
    render(<AccountMenu />);
    const user = await openFromKeyboard();
    await user.keyboard('u');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Usage' })).toHaveFocus();
    });

    await new Promise((resolve) => setTimeout(resolve, SEARCH_LAPSE_MS));
    await user.keyboard('s');

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Support' })).toHaveFocus();
    });
  });
});
