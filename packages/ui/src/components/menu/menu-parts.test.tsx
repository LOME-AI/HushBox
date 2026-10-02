import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Menu } from './menu';
import { MenuFooter } from './menu-footer';
import { MenuItem } from './menu-item';
import { MenuLabel } from './menu-label';
import { MenuSeparator } from './menu-separator';
import { DESKTOP, PHONE, installViewport, restoreViewport } from './menu-viewport.setup';

afterEach(() => {
  restoreViewport();
});

async function openParts(width: number): Promise<HTMLElement> {
  installViewport(width);
  render(
    <Menu trigger={<button type="button">More</button>} title="More options">
      <MenuLabel>Account</MenuLabel>
      <MenuItem title="Settings" onSelect={vi.fn()} />
      <MenuSeparator />
      <MenuItem title="Log out" onSelect={vi.fn()} />
      <MenuFooter>Signed in on this device</MenuFooter>
    </Menu>
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));
  return screen.findByRole('menu');
}

describe.each([
  ['a sheet', PHONE],
  ['an anchored menu', DESKTOP],
])('menu parts in %s', (_presentation, width) => {
  it('draws a separator between items', async () => {
    const menu = await openParts(width);

    expect(menu.querySelector('[role="separator"]')).toHaveClass('bg-border', 'h-px');
  });

  it('draws a label in the menu', async () => {
    const menu = await openParts(width);

    expect(menu).toContainElement(screen.getByText('Account'));
  });

  it('sets the label at 500', async () => {
    await openParts(width);

    expect(screen.getByText('Account')).toHaveClass('font-medium');
  });

  it('draws the footer in muted small text', async () => {
    await openParts(width);

    expect(screen.getByText('Signed in on this device')).toHaveClass(
      'text-muted-foreground',
      'text-xs'
    );
  });

  it('keeps the footer out of the items', async () => {
    await openParts(width);

    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('puts no test id on a label given none', async () => {
    await openParts(width);

    expect(screen.getByText('Account')).not.toHaveAttribute('data-testid');
  });

  it('places a caller test id on the label element', async () => {
    installViewport(width);
    render(
      <Menu trigger={<button type="button">Options</button>} title="Options">
        <MenuLabel data-testid="options-label">Change privilege</MenuLabel>
        <MenuItem title="Remove" onSelect={vi.fn()} />
      </Menu>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Options' }));
    await screen.findByRole('menu');

    expect(screen.getByTestId('options-label')).toBe(screen.getByText('Change privilege'));
  });
});
