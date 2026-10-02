import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, onTestFinished } from 'vitest';
import { Overlay } from '../overlay/overlay';
import { MENU_TRIGGER_ID_ATTRIBUTE } from '../overlay/overlay-focus-return';
import { Menu } from './menu';
import { MenuItem } from './menu-item';
import {
  PHONE,
  installViewport,
  restoreViewport,
  stopSheetAnimations,
} from './menu-viewport.setup';

afterEach(() => {
  restoreViewport();
});

/** A row's menu whose item opens a dialog, as the sidebar row's Rename does. */
function RowMenu(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  return (
    <>
      <nav aria-label="Chats">
        <Menu trigger={<button type="button">More for Trip</button>} title="Trip">
          <MenuItem
            title="Rename"
            onSelect={() => {
              setDialogOpen(true);
            }}
          />
        </Menu>
      </nav>
      <main aria-label="Page" />
      <Overlay open={dialogOpen} onOpenChange={setDialogOpen} ariaLabel="Rename conversation">
        <button
          type="button"
          onClick={() => {
            setDialogOpen(false);
          }}
        >
          Cancel
        </button>
      </Overlay>
    </>
  );
}

describe('MenuSheet', () => {
  it('returns focus to the menu trigger when a dialog its item opened closes', async () => {
    installViewport(PHONE);
    onTestFinished(stopSheetAnimations());
    const user = userEvent.setup();
    render(<RowMenu />);

    await user.click(screen.getByRole('button', { name: 'More for Trip' }));
    // Chosen by key: a pointer release inside a sheet reads a computed transform this DOM lacks.
    const rename = await screen.findByRole('menuitem', { name: 'Rename' });
    rename.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More for Trip' })).toHaveFocus();
    });
  });

  it('keeps the sheet menu named by its title', async () => {
    installViewport(PHONE);
    const user = userEvent.setup();
    render(<RowMenu />);

    await user.click(screen.getByRole('button', { name: 'More for Trip' }));

    expect(await screen.findByRole('menu', { name: 'Trip' })).toBeInTheDocument();
  });

  it('names no trigger when it opens with focus on no element that has an id', () => {
    installViewport(PHONE);
    render(
      <Menu open trigger={<button type="button">More for Trip</button>} title="Trip">
        <MenuItem title="Rename" onSelect={() => {}} />
      </Menu>
    );

    expect(
      screen.getByRole('menu', { name: 'Trip' }).closest(`[${MENU_TRIGGER_ID_ATTRIBUTE}]`)
    ).toBeNull();
  });
});
