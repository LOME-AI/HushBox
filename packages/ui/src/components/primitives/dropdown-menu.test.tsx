import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, onTestFinished, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuGroup,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from './dropdown-menu';
import { PortalContainerProvider } from './portal-container';

type ItemKind = 'item' | 'checkbox' | 'radio';

/**
 * A menu whose Settings item moves focus to the page heading once the navigation resolves, as
 * the route announcer does. Focus moved inside `onSelect` itself would be pulled back into the
 * still-open menu by its focus trap, so the move waits a task, as a route change does.
 */
function NavigatingMenuHarness({
  kind = 'item',
}: Readonly<{ kind?: ItemKind }>): React.JSX.Element {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const focusPageSoon = (): void => {
    setTimeout(() => {
      headingRef.current?.focus();
    }, 0);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          {kind === 'item' && (
            <DropdownMenuItem onSelect={focusPageSoon}>Settings</DropdownMenuItem>
          )}
          {kind === 'checkbox' && (
            <DropdownMenuCheckboxItem onSelect={focusPageSoon}>Settings</DropdownMenuCheckboxItem>
          )}
          {kind === 'radio' && (
            <DropdownMenuRadioGroup value="settings">
              <DropdownMenuRadioItem value="settings" onSelect={focusPageSoon}>
                Settings
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <main>
        <h1 ref={headingRef} tabIndex={-1}>
          Settings
        </h1>
      </main>
    </>
  );
}

/** Radix returns focus on a zero-delay timer after the menu unmounts; this runs after it. */
async function afterCloseFocus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Presses a key on the focused element, then yields one microtask checkpoint and no timer turn,
 * as a browser does between two key events queued behind a long task.
 */
async function pressBeforeATimerTurn(key: string): Promise<void> {
  const target = document.activeElement;
  if (target === null) throw new Error('No element holds focus');
  fireEvent.keyDown(target, { key });
  await Promise.resolve();
}

describe('DropdownMenu focus on close', () => {
  it('leaves focus on the element a keyboard-chosen item moved it to', async () => {
    const user = userEvent.setup();
    render(<NavigatingMenuHarness />);

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await afterCloseFocus();

    expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus();
  });

  it('leaves focus on the element a pointer-chosen item moved it to', async () => {
    const user = userEvent.setup();
    render(<NavigatingMenuHarness />);

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Settings' }));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await afterCloseFocus();

    expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus();
  });

  it('returns focus to the trigger when a pointer-chosen item moves focus nowhere', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Copy link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const trigger = screen.getByRole('button', { name: 'Account' });

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await afterCloseFocus();

    expect(trigger).toHaveFocus();
  });

  it("runs the consumer's own onCloseAutoFocus", async () => {
    const user = userEvent.setup();
    const onCloseAutoFocus = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={onCloseAutoFocus}>
          <DropdownMenuItem>Copy link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await afterCloseFocus();

    expect(onCloseAutoFocus).toHaveBeenCalledOnce();
  });
});

/**
 * Keeps a closed menu on the page in its exit animation, as a browser does while it plays.
 * Radix unmounts the content on `animationend`, which happy-dom never fires.
 */
function holdExitAnimation(): () => void {
  const style = document.createElement('style');
  style.textContent =
    '[role="menu"][data-state="closed"] { animation-name: menu-exit; animation-duration: 1s; }';
  document.head.append(style);
  return () => {
    style.remove();
  };
}

describe('DropdownMenu items while the menu closes', () => {
  let releaseExitAnimation: () => void;

  beforeEach(() => {
    releaseExitAnimation = holdExitAnimation();
  });

  afterEach(() => {
    releaseExitAnimation();
  });

  /**
   * Chooses Settings by keyboard and waits until the page has taken focus. The closing menu
   * still hides the rest of the page from the accessibility tree, hence `hidden: true`.
   */
  async function chooseSettingsAndLand(
    user: ReturnType<typeof userEvent.setup>,
    role: string
  ): Promise<HTMLElement> {
    await user.tab();
    await user.keyboard('{Enter}');
    const item = await screen.findByRole(role, { name: 'Settings' });
    await waitFor(() => {
      expect(item).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    const heading = screen.getByRole('heading', { name: 'Settings', hidden: true });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(item.closest('[role="menu"]')).toHaveAttribute('data-state', 'closed');
    return item;
  }

  const ITEM_KINDS = [
    ['an item', 'item', 'menuitem'],
    ['a checkbox item', 'checkbox', 'menuitemcheckbox'],
    ['a radio item', 'radio', 'menuitemradio'],
  ] as const;

  it.each(ITEM_KINDS)(
    'leaves focus where it was when the pointer leaves %s',
    async (_label, kind, role) => {
      const user = userEvent.setup();
      render(<NavigatingMenuHarness kind={kind} />);
      const item = await chooseSettingsAndLand(user, role);

      fireEvent.pointerLeave(item, { pointerType: 'mouse' });

      expect(screen.getByRole('heading', { name: 'Settings', hidden: true })).toHaveFocus();
    }
  );

  it.each(ITEM_KINDS)(
    'leaves focus where it was when the pointer moves over %s',
    async (_label, kind, role) => {
      const user = userEvent.setup();
      render(<NavigatingMenuHarness kind={kind} />);
      const item = await chooseSettingsAndLand(user, role);

      fireEvent.pointerMove(item, { pointerType: 'mouse' });

      expect(screen.getByRole('heading', { name: 'Settings', hidden: true })).toHaveFocus();
    }
  );
});

describe('DropdownMenu pointer highlighting while open', () => {
  function TwoItemMenu(): React.JSX.Element {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>First</DropdownMenuItem>
          <DropdownMenuItem>Second</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it('highlights the item under a moving pointer', async () => {
    const user = userEvent.setup();
    render(<TwoItemMenu />);

    await user.click(screen.getByRole('button', { name: 'Account' }));
    const second = await screen.findByRole('menuitem', { name: 'Second' });
    await user.hover(second);

    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('data-highlighted');
  });

  it('clears the highlight of an item the pointer leaves', async () => {
    const user = userEvent.setup();
    render(<TwoItemMenu />);

    await user.click(screen.getByRole('button', { name: 'Account' }));
    const second = await screen.findByRole('menuitem', { name: 'Second' });
    await user.hover(second);
    expect(second).toHaveAttribute('data-highlighted');
    // `user.unhover` refuses here: the open modal menu gives the page `pointer-events: none`.
    fireEvent.pointerLeave(second, { pointerType: 'mouse' });

    expect(screen.getByRole('menu')).toHaveFocus();
    expect(second).not.toHaveAttribute('data-highlighted');
  });

  it("runs an item's own onPointerMove", async () => {
    const user = userEvent.setup();
    const onPointerMove = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onPointerMove={onPointerMove}>First</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.pointerMove(await screen.findByRole('menuitem', { name: 'First' }), {
      pointerType: 'mouse',
    });

    expect(onPointerMove).toHaveBeenCalledOnce();
  });

  it("runs an item's own onPointerLeave", async () => {
    const user = userEvent.setup();
    const onPointerLeave = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onPointerLeave={onPointerLeave}>First</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.pointerLeave(await screen.findByRole('menuitem', { name: 'First' }), {
      pointerType: 'mouse',
    });

    expect(onPointerLeave).toHaveBeenCalledOnce();
  });
});

describe('DropdownMenu', () => {
  it('renders trigger element', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(screen.getByText('Open Menu')).toBeInTheDocument();
  });

  it('opens menu when trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open Menu'));
    await waitFor(() => {
      expect(screen.getByText('Item 1')).toBeInTheDocument();
    });
  });

  it('closes menu when item is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>Item 1</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open Menu'));
    await waitFor(() => {
      expect(screen.getByText('Item 1')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Item 1'));
    expect(onSelect).toHaveBeenCalled();
  });

  it('trigger has data-slot attribute', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="trigger">Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'dropdown-menu-trigger');
  });

  it('renders controlled menu', () => {
    const onOpenChange = vi.fn();
    render(
      <DropdownMenu open={true} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Controlled Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(screen.getByText('Controlled Item')).toBeInTheDocument();
  });

  it('moves focus between items with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>First</DropdownMenuItem>
          <DropdownMenuItem>Second</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');

    const second = screen.getByRole('menuitem', { name: 'Second' });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('data-slot', 'dropdown-menu-item');
  });

  it('chooses the item the arrow keys reached when each key arrives before a timer turn', async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    const ITEM_NAMES = ['Pin', 'Mute', 'Rename', 'Delete'] as const;
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>More options</DropdownMenuTrigger>
        <DropdownMenuContent>
          {ITEM_NAMES.map((name) => (
            <DropdownMenuItem
              key={name}
              onSelect={() => {
                chosen.push(name);
              }}
            >
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Pin' })).toHaveFocus();
    });

    await act(async () => {
      await pressBeforeATimerTurn('ArrowDown');
      await pressBeforeATimerTurn('ArrowDown');
      await pressBeforeATimerTurn('Enter');
    });

    expect(chosen).toEqual(['Rename']);
  });

  it('chooses the item typeahead reached when Enter arrives before a timer turn', async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    const ITEM_NAMES = ['Pin', 'Mute', 'Rename', 'Delete'] as const;
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>More options</DropdownMenuTrigger>
        <DropdownMenuContent>
          {ITEM_NAMES.map((name) => (
            <DropdownMenuItem
              key={name}
              onSelect={() => {
                chosen.push(name);
              }}
            >
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Pin' })).toHaveFocus();
    });

    await act(async () => {
      await pressBeforeATimerTurn('r');
      await pressBeforeATimerTurn('Enter');
    });

    expect(chosen).toEqual(['Rename']);
  });

  it('returns focus to the trigger when an item is chosen by keyboard', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>First</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              onSelect('second');
            }}
          >
            Second
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
    expect(onSelect).toHaveBeenCalledWith('second');
  });
});

describe('DropdownMenuItem', () => {
  it('applies custom className', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem className="custom-class" data-testid="item">
            Item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveClass('custom-class');
    });
  });

  it('supports destructive variant', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive" data-testid="item">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveAttribute('data-variant', 'destructive');
    });
  });

  it('supports inset prop', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem inset data-testid="item">
            Inset Item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('item')).toHaveAttribute('data-inset', 'true');
    });
  });
});

describe('DropdownMenuLabel', () => {
  it('renders label text', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>My Label</DropdownMenuLabel>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('My Label')).toBeInTheDocument();
    });
  });

  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel data-testid="label">Label</DropdownMenuLabel>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('label')).toHaveAttribute('data-slot', 'dropdown-menu-label');
    });
  });
});

describe('DropdownMenuSeparator', () => {
  it('renders separator', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuSeparator data-testid="separator" />
          <DropdownMenuItem>Item 2</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('separator')).toHaveAttribute(
        'data-slot',
        'dropdown-menu-separator'
      );
    });
  });
});

describe('DropdownMenuCheckboxItem', () => {
  it('renders checkbox item', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={true}>Checked Item</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Checked Item')).toBeInTheDocument();
    });
  });

  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={false} data-testid="checkbox">
            Checkbox
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('checkbox')).toHaveAttribute(
        'data-slot',
        'dropdown-menu-checkbox-item'
      );
    });
  });
});

describe('DropdownMenuRadioGroup', () => {
  it('renders radio group with items', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="option1">
            <DropdownMenuRadioItem value="option1">Option 1</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="option2">Option 2</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Option 1')).toBeInTheDocument();
      expect(screen.getByText('Option 2')).toBeInTheDocument();
    });
  });

  it('radio item has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="option1">
            <DropdownMenuRadioItem value="option1" data-testid="radio">
              Option
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('radio')).toHaveAttribute('data-slot', 'dropdown-menu-radio-item');
    });
  });
});

describe('DropdownMenuGroup', () => {
  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup data-testid="group">
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('group')).toHaveAttribute('data-slot', 'dropdown-menu-group');
    });
  });
});

describe('DropdownMenuShortcut', () => {
  it('renders shortcut text', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            Copy
            <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('⌘C')).toBeInTheDocument();
    });
  });

  it('has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            Copy
            <DropdownMenuShortcut data-testid="shortcut">⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('shortcut')).toHaveAttribute('data-slot', 'dropdown-menu-shortcut');
    });
  });
});

describe('DropdownMenuSub', () => {
  it('renders submenu trigger', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More Options</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Sub Item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('More Options')).toBeInTheDocument();
    });
  });

  it('sub trigger has data-slot attribute', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="sub-trigger">More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Sub</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByTestId('sub-trigger')).toHaveAttribute(
        'data-slot',
        'dropdown-menu-sub-trigger'
      );
    });
  });

  it('defaults a checkbox item to unchecked when no checked prop is given', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem>Toggle me</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      const item = screen.getByRole('menuitemcheckbox', { name: 'Toggle me' });
      expect(item).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('renders content through an explicit DropdownMenuPortal', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent>
            <DropdownMenuItem>Portalled item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    );
    await user.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Portalled item')).toBeInTheDocument();
    });
  });
});

/** An element outside the rendered tree for a portal to land in, removed after the test. */
function portalTarget(): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  onTestFinished(() => {
    target.remove();
  });
  return target;
}

/** The element directly under the document body that holds `element`. */
function bodyChildHolding(element: HTMLElement): Element | undefined {
  return [...document.body.children].find((child) => child.contains(element));
}

describe('DropdownMenuContent portal', () => {
  it('portals the menu to the document body when given no container', () => {
    const { container } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const holder = bodyChildHolding(screen.getByRole('menu'));
    expect(holder).toBeDefined();
    expect(holder).not.toBe(container);
  });

  it('portals the menu into the container it is given', () => {
    const target = portalTarget();
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent container={target}>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(target).toContainElement(screen.getByRole('menu'));
  });

  it('portals the menu into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <DropdownMenu open>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByRole('menu'));
  });

  it('portals the menu into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <DropdownMenu open>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent container={own}>
            <DropdownMenuItem>Rename</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByRole('menu'));
    expect(provided).not.toContainElement(screen.getByRole('menu'));
  });
});
