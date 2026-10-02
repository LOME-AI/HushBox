import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Menu } from './menu';
import { MenuItem } from './menu-item';
import {
  DESKTOP,
  PHONE,
  installViewport,
  restoreViewport,
  stopSheetAnimations,
} from './menu-viewport.setup';

let restoreAnimations: () => void = () => {};

beforeEach(() => {
  restoreAnimations = stopSheetAnimations();
});

afterEach(() => {
  restoreAnimations();
  restoreViewport();
});

function ThreeItems({ onUsage = vi.fn() }: Readonly<{ onUsage?: () => void }>): React.JSX.Element {
  return (
    <Menu trigger={<button type="button">More</button>} title="More options">
      <MenuItem title="Settings" onSelect={vi.fn()} />
      <MenuItem title="Usage" onSelect={onUsage} />
      <MenuItem title="Export" disabled disabledReason="Nothing to export yet" onSelect={vi.fn()} />
    </Menu>
  );
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'More', hidden: true });
}

/** Opens the menu from the keyboard, as Enter on the focused trigger does. */
async function openFromKeyboard(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  await screen.findByRole('menu');
  return user;
}

async function closed(): Promise<void> {
  await waitFor(() => {
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });
}

describe.each([
  ['a sheet', PHONE],
  ['an anchored menu', DESKTOP],
])('Menu keyboard in %s', (_presentation, width) => {
  it('focuses the first item when opened from the keyboard', async () => {
    installViewport(width);
    render(<ThreeItems />);

    await openFromKeyboard();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    });
  });

  it('focuses the menu itself when opened by a click', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = userEvent.setup();

    await user.click(trigger());

    await waitFor(() => {
      expect(screen.getByRole('menu')).toHaveFocus();
    });
  });

  it('moves from the menu to its first item on ArrowDown', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = userEvent.setup();
    await user.click(trigger());
    await waitFor(() => {
      expect(screen.getByRole('menu')).toHaveFocus();
    });

    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('moves from the menu to its last item on ArrowUp', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = userEvent.setup();
    await user.click(trigger());
    await waitFor(() => {
      expect(screen.getByRole('menu')).toHaveFocus();
    });

    await user.keyboard('{ArrowUp}');

    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveFocus();
  });

  it('moves to the next item on ArrowDown', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    });

    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'Usage' })).toHaveFocus();
  });

  it('moves to the previous item on ArrowUp', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{ArrowUp}');

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('reaches a disabled item, so its reason is read', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();

    await user.keyboard('{End}');

    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveFocus();
  });

  it('goes back to the first item on Home', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();
    await user.keyboard('{End}');

    await user.keyboard('{Home}');

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('goes to the last item on PageDown', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();

    await user.keyboard('{PageDown}');

    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveFocus();
  });

  it('goes to the first item on PageUp', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();
    await user.keyboard('{End}');

    await user.keyboard('{PageUp}');

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('stays on the last item on ArrowDown', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();
    await user.keyboard('{End}');

    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveFocus();
  });

  it('chooses the focused item on Enter', async () => {
    installViewport(width);
    const onUsage = vi.fn();
    render(<ThreeItems onUsage={onUsage} />);
    const user = await openFromKeyboard();
    await user.keyboard('{ArrowDown}');

    await user.keyboard('{Enter}');

    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('chooses the focused item on Space', async () => {
    installViewport(width);
    const onUsage = vi.fn();
    render(<ThreeItems onUsage={onUsage} />);
    const user = await openFromKeyboard();
    await user.keyboard('{ArrowDown}');

    await user.keyboard(' ');

    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('returns focus to the trigger after an item is chosen', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();

    await user.keyboard('{Enter}');
    await closed();

    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
  });

  it('returns focus to the trigger on Escape', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = await openFromKeyboard();

    await user.keyboard('{Escape}');
    await closed();

    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
  });

  it('returns focus to the trigger when a menu opened by a click closes on Escape', async () => {
    installViewport(width);
    render(<ThreeItems />);
    const user = userEvent.setup();
    await user.click(trigger());
    await waitFor(() => {
      expect(screen.getByRole('menu')).toHaveFocus();
    });

    await user.keyboard('{Escape}');
    await closed();

    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
  });
});
