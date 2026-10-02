import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Settings } from 'lucide-react';
import { Menu } from './menu';
import { MenuItem, type MenuItemProps } from './menu-item';
import { MenuRadioItem } from './menu-radio-item';
import { DESKTOP, PHONE, installViewport, restoreViewport } from './menu-viewport.setup';

const cleanups: (() => void)[] = [];

afterEach(() => {
  restoreViewport();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Records each link a click would follow, then stops the follow: the test environment would
 * otherwise try to leave the page.
 */
function watchFollows(): string[] {
  const followed: string[] = [];
  const listener = (event: MouseEvent): void => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link !== null && !event.defaultPrevented) followed.push(link.getAttribute('href') ?? '');
    event.preventDefault();
  };
  globalThis.addEventListener('click', listener);
  cleanups.push(() => {
    globalThis.removeEventListener('click', listener);
  });
  return followed;
}

const REPO = 'https://github.com/lome-ai/hushbox';

async function openWith(item: React.ReactElement, width: number): Promise<HTMLElement> {
  installViewport(width);
  render(
    <Menu trigger={<button type="button">More</button>} title="More options">
      {item}
    </Menu>
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));
  return screen.findByRole('menu');
}

/** An item that runs its choice, rather than a link. */
type ChoiceItemProps = Extract<MenuItemProps, { onSelect: () => void }>;

function item(props: Partial<ChoiceItemProps> = {}): React.ReactElement {
  return <MenuItem title="Settings" onSelect={vi.fn()} {...props} />;
}

describe.each([
  ['a sheet', PHONE],
  ['an anchored menu', DESKTOP],
])('MenuItem in %s', (_presentation, width) => {
  it('is a menuitemcheckbox when checked is set', async () => {
    await openWith(item({ checked: true }), width);

    expect(screen.getByRole('menuitemcheckbox', { name: 'Settings' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('reads unchecked while checked is false', async () => {
    await openWith(item({ checked: false }), width);

    expect(screen.getByRole('menuitemcheckbox', { name: 'Settings' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('calls onSelect when a checkable item is chosen', async () => {
    const onSelect = vi.fn();
    await openWith(item({ checked: false, onSelect }), width);

    // A bare click: vaul's release handler throws on a pointer release inside a test sheet.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Settings' }));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('is named by its title alone, whatever its end slot holds', async () => {
    await openWith(item({ end: 'Ctrl ,' }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
  });

  it('draws its end slot', async () => {
    await openWith(item({ end: 'Ctrl ,' }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveTextContent('Ctrl ,');
  });

  it('is described by its description', async () => {
    await openWith(item({ description: 'Account and privacy' }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAccessibleDescription(
      'Account and privacy'
    );
  });

  it('shows its reason in place of its description while disabled', async () => {
    await openWith(
      item({ description: 'Account and privacy', disabled: true, disabledReason: 'Sign in first' }),
      width
    );

    expect(screen.getByRole('menuitem', { name: 'Settings' })).not.toHaveTextContent(
      'Account and privacy'
    );
  });

  it('is aria-disabled while disabled', async () => {
    await openWith(item({ disabled: true }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('does not call onSelect while disabled', async () => {
    const onSelect = vi.fn();
    await openWith(item({ disabled: true, onSelect }), width);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('greys a disabled title with the disabled ink', async () => {
    await openWith(item({ disabled: true }), width);

    expect(screen.getByText('Settings')).toHaveClass('group-aria-disabled:text-disabled-ink');
  });

  it('keeps a disabled reason in the muted ink', async () => {
    await openWith(item({ disabled: true, disabledReason: 'Sign in first' }), width);

    expect(screen.getByText('Sign in first')).toHaveClass('text-muted-foreground');
  });

  it('draws the danger tone in the error colour', async () => {
    await openWith(item({ tone: 'danger' }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveClass('text-destructive');
  });

  it('draws its icon muted', async () => {
    await openWith(item({ icon: Settings }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' }).querySelector('svg')).toHaveClass(
      'text-muted-foreground'
    );
  });

  it('draws a danger icon in the error colour', async () => {
    await openWith(item({ icon: Settings, tone: 'danger' }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' }).querySelector('svg')).toHaveClass(
      'text-destructive'
    );
  });

  it('puts the check after the title when the item has an icon', async () => {
    await openWith(item({ icon: Settings, checked: true }), width);

    const row = screen.getByRole('menuitemcheckbox', { name: 'Settings' });
    expect(row.lastElementChild).toHaveClass('text-muted-foreground');
  });

  it('puts the check in the icon place when the item has no icon', async () => {
    await openWith(item({ checked: true }), width);

    const row = screen.getByRole('menuitemcheckbox', { name: 'Settings' });
    expect(row.firstElementChild).toHaveClass('text-muted-foreground');
  });

  it('shows the check only while checked', async () => {
    await openWith(item({ checked: false }), width);

    const row = screen.getByRole('menuitemcheckbox', { name: 'Settings' });
    expect(row.firstElementChild).toHaveClass('invisible', 'group-aria-checked:visible');
  });

  it('sets a checkable title at 500 and a checked one at 600', async () => {
    await openWith(item({ checked: true }), width);

    expect(screen.getByText('Settings')).toHaveClass(
      'font-medium',
      'group-aria-checked:font-semibold'
    );
  });

  it('carries its test id on the element with its role', async () => {
    await openWith(item({ 'data-testid': 'menu-settings' }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'data-testid',
      'menu-settings'
    );
  });

  it('carries its test id on a checkable item', async () => {
    await openWith(item({ checked: false, 'data-testid': 'menu-touch' }), width);

    expect(screen.getByRole('menuitemcheckbox', { name: 'Settings' })).toHaveAttribute(
      'data-testid',
      'menu-touch'
    );
  });

  it('gives a two-line item the taller padding', async () => {
    await openWith(item({ description: 'Account and privacy' }), width);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveClass('py-1.75');
  });
});

describe.each([
  ['a sheet', PHONE],
  ['an anchored menu', DESKTOP],
])('a link MenuItem in %s', (_presentation, width) => {
  it('is a menuitem link to its href', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external />, width);

    const row = screen.getByRole('menuitem', { name: 'GitHub' });
    expect(row).toHaveAttribute('href', REPO);
  });

  it('is an anchor, so the browser offers to open it in a new tab', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external />, width);

    expect(screen.getByRole('menuitem', { name: 'GitHub' }).tagName).toBe('A');
  });

  it('opens an external link in a new tab', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external />, width);

    expect(screen.getByRole('menuitem', { name: 'GitHub' })).toHaveAttribute('target', '_blank');
  });

  it('keeps an external tab from reaching back into this one', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external />, width);

    expect(screen.getByRole('menuitem', { name: 'GitHub' })).toHaveAttribute(
      'rel',
      'noopener noreferrer'
    );
  });

  it('opens a link that is not external in this tab', async () => {
    await openWith(<MenuItem title="About HushBox" href="/welcome" />, width);

    const row = screen.getByRole('menuitem', { name: 'About HushBox' });
    expect([row.getAttribute('target'), row.getAttribute('rel')]).toEqual([null, null]);
  });

  it('follows its link on Enter', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external />, width);
    const followed = watchFollows();

    await userEvent.setup().keyboard('{ArrowDown}{Enter}');

    expect(followed).toEqual([REPO]);
  });

  it('follows its link on Space', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external />, width);
    const followed = watchFollows();

    await userEvent.setup().keyboard('{ArrowDown} ');

    expect(followed).toEqual([REPO]);
  });

  it('does not follow its link on a space that continues a typed search', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external />, width);
    const followed = watchFollows();

    await userEvent.setup().keyboard('{ArrowDown}gi ');

    expect(followed).toEqual([]);
  });

  it('calls onSelect as its link is followed', async () => {
    const onSelect = vi.fn();
    await openWith(<MenuItem title="GitHub" href={REPO} external onSelect={onSelect} />, width);
    watchFollows();

    fireEvent.click(screen.getByRole('menuitem', { name: 'GitHub' }));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('carries no href while disabled, so nothing a browser offers can follow it', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external disabled />, width);

    expect(screen.getByRole('menuitem', { name: 'GitHub' })).not.toHaveAttribute('href');
  });

  it('carries no new-tab target while disabled', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external disabled />, width);

    const row = screen.getByRole('menuitem', { name: 'GitHub' });
    expect([row.getAttribute('target'), row.getAttribute('rel')]).toEqual([null, null]);
  });

  it('keeps its role and name while disabled, and is announced as disabled', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external disabled />, width);

    expect(screen.getByRole('menuitem', { name: 'GitHub' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('is drawn while disabled as a disabled item that is not a link is', async () => {
    installViewport(width);
    render(
      <Menu trigger={<button type="button">More</button>} title="More options">
        <MenuItem icon={Settings} title="Settings" disabled onSelect={vi.fn()} />
        <MenuItem icon={Settings} title="GitHub" href={REPO} external disabled />
      </Menu>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));

    const link = await screen.findByRole('menuitem', { name: 'GitHub' });
    expect(link.className).toBe(screen.getByRole('menuitem', { name: 'Settings' }).className);
  });

  it('does not follow its link while disabled', async () => {
    await openWith(<MenuItem title="GitHub" href={REPO} external disabled />, width);
    const followed = watchFollows();

    fireEvent.click(screen.getByRole('menuitem', { name: 'GitHub' }));

    expect(followed).toEqual([]);
  });

  it('does not call onSelect while disabled', async () => {
    const onSelect = vi.fn();
    await openWith(
      <MenuItem title="GitHub" href={REPO} external disabled onSelect={onSelect} />,
      width
    );
    watchFollows();

    fireEvent.click(screen.getByRole('menuitem', { name: 'GitHub' }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('carries its test id', async () => {
    await openWith(
      <MenuItem title="GitHub" href={REPO} external data-testid="menu-github" />,
      width
    );

    expect(screen.getByRole('menuitem', { name: 'GitHub' })).toHaveAttribute(
      'data-testid',
      'menu-github'
    );
  });

  it('is drawn as an item that is not a link is', async () => {
    installViewport(width);
    render(
      <Menu trigger={<button type="button">More</button>} title="More options">
        <MenuItem icon={Settings} title="Settings" onSelect={vi.fn()} />
        <MenuItem icon={Settings} title="GitHub" href={REPO} external />
      </Menu>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));

    const link = await screen.findByRole('menuitem', { name: 'GitHub' });
    expect(link.className).toBe(screen.getByRole('menuitem', { name: 'Settings' }).className);
  });
});

describe('MenuItem heights', () => {
  it('is always touch height in a sheet', async () => {
    await openWith(item(), PHONE);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveClass('min-h-11');
  });

  it('is 2rem anchored, and touch height under a coarse pointer', async () => {
    await openWith(item(), DESKTOP);

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveClass(
      'min-h-8',
      'pointer-coarse:min-h-11'
    );
  });
});

describe('menu parts outside a menu', () => {
  it('refuses to render an item outside a Menu', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(item())).toThrow('A menu part renders only inside a Menu');
  });

  it('refuses to render a radio item outside a MenuRadioGroup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installViewport(DESKTOP);

    await expect(openWith(<MenuRadioItem value="a" title="A" />, DESKTOP)).rejects.toThrow(
      'A MenuRadioItem renders only inside a MenuRadioGroup'
    );
  });
});
