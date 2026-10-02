import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { Overlay } from './overlay';
import { MENU_TRIGGER_ID_ATTRIBUTE } from './overlay-focus-return';

function OpenerHarness({
  autoFocusField = false,
  onCloseAutoFocus,
}: Readonly<{
  autoFocusField?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <Overlay
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Test overlay"
        {...(onCloseAutoFocus !== undefined && { onCloseAutoFocus })}
      >
        {autoFocusField && (
          // eslint-disable-next-line jsx-a11y/no-autofocus -- a field that takes focus as the overlay mounts, as the rename dialog's does
          <input aria-label="Name" autoFocus />
        )}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
        >
          Confirm
        </button>
      </Overlay>
    </>
  );
}

/** Opener inside a `<nav>`, beside a `<main>`, with an in-overlay control that removes it. */
function RemovableOpenerHarness({
  mainTabIndex,
  withMain = true,
}: Readonly<{ mainTabIndex?: number; withMain?: boolean }>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [openerShown, setOpenerShown] = React.useState(true);
  return (
    <>
      <nav aria-label="Sections">
        {openerShown && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Open
          </button>
        )}
      </nav>
      {withMain && <main aria-label="Page" tabIndex={mainTabIndex} />}
      <Overlay open={open} onOpenChange={setOpen} ariaLabel="Test overlay">
        <button
          type="button"
          onClick={() => {
            setOpenerShown(false);
          }}
        >
          Remove opener
        </button>
      </Overlay>
    </>
  );
}

/**
 * A menu button's menu whose item opens the overlay, as a row's "More options" menu does. Named by
 * its title, the menu names its button through the enclosing trigger-id mark, as a sheet does.
 */
function MenuHarness({
  naming = 'labelledby',
}: Readonly<{ naming?: 'labelledby' | 'title' }>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [menuShown, setMenuShown] = React.useState(true);
  // The menu leaves the page once its item has opened the overlay, as Radix's does when its
  // exit animation ends.
  React.useEffect(() => {
    if (open) setMenuShown(false);
  }, [open]);
  return (
    <>
      <button type="button" id="row-menu" aria-haspopup="menu">
        More options
      </button>
      {menuShown && (
        <div {...(naming === 'title' && { [MENU_TRIGGER_ID_ATTRIBUTE]: 'row-menu' })}>
          <div
            role="menu"
            {...(naming === 'title' ? { 'aria-label': 'Trip' } : { 'aria-labelledby': 'row-menu' })}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(true);
              }}
            >
              Rename
            </button>
          </div>
        </div>
      )}
      <main aria-label="Page" />
      <Overlay open={open} onOpenChange={setOpen} ariaLabel="Test overlay">
        <button type="button">Inside</button>
      </Overlay>
    </>
  );
}

/** An overlay opened and closed by the page itself, with nothing focused beforehand. */
function ProgrammaticHarness({ open }: Readonly<{ open: boolean }>): React.JSX.Element {
  return (
    <>
      <main aria-label="Page" />
      <Overlay open={open} onOpenChange={() => {}} ariaLabel="Test overlay">
        <button type="button">Inside</button>
      </Overlay>
    </>
  );
}

/** A reply action that closes the overlay and focuses the composer itself. */
function PageFocusHarness(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [replying, setReplying] = React.useState(false);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (replying) composerRef.current?.focus();
  }, [replying]);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      <textarea aria-label="Composer" ref={composerRef} />
      <Overlay open={open} onOpenChange={setOpen} ariaLabel="Test overlay">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setReplying(true);
          }}
        >
          Reply
        </button>
      </Overlay>
    </>
  );
}

/** Radix returns focus on a zero-delay timer after the content unmounts; this runs after it. */
async function afterCloseFocus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openFrom(
  opener: HTMLElement,
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await user.click(opener);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
}

/**
 * vaul animates the sheet out and Radix unmounts it on `animationend`, which happy-dom
 * never fires. `apps/web/src/app.css` stops animations the same way under `[data-e2e]`.
 */
function stopSheetAnimations(): () => void {
  const style = document.createElement('style');
  style.textContent =
    '[data-vaul-drawer], [data-vaul-overlay] { animation-name: none !important; }';
  document.head.append(style);
  return () => {
    style.remove();
  };
}

type ChangeListener = (event: MediaQueryListEvent) => void;

interface MediaListStub {
  readonly matches: boolean;
  readonly media: string;
  readonly addEventListener: (type: string, listener: ChangeListener) => void;
  readonly removeEventListener: (type: string, listener: ChangeListener) => void;
}

const originalMatchMedia = globalThis.matchMedia;

/** Stubs `matchMedia` for a window `width` wide with a fine pointer; `resize` moves it. */
function installWidth(initialWidth: number): { readonly resize: (width: number) => void } {
  let width = initialWidth;
  const listeners = new Map<string, Set<ChangeListener>>();
  const matchesQuery = (query: string): boolean => {
    const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
    return maxWidth?.[1] !== undefined && width <= Number(maxWidth[1]);
  };
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const set = listeners.get(query) ?? new Set<ChangeListener>();
      listeners.set(query, set);
      const list: MediaListStub = {
        matches: matchesQuery(query),
        media: query,
        addEventListener: (_type: string, listener: ChangeListener): void => {
          set.add(listener);
        },
        removeEventListener: (_type: string, listener: ChangeListener): void => {
          set.delete(listener);
        },
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
  return {
    resize: (next): void => {
      width = next;
      for (const [query, set] of listeners) {
        // The band and pointer listeners read only `matches`.
        const event = { matches: matchesQuery(query), media: query } as MediaQueryListEvent;
        for (const listener of set) listener(event);
      }
    },
  };
}

describe('Overlay focus return', () => {
  let restoreAnimations: () => void;

  beforeEach(() => {
    restoreAnimations = stopSheetAnimations();
  });

  afterEach(() => {
    restoreAnimations();
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
  });

  it('returns focus to the opening button when Escape closes the dialog', async () => {
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await openFrom(opener, user);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('returns focus to the opening button when Escape closes the bottom sheet', async () => {
    installWidth(767);
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await openFrom(opener, user);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('returns focus to the opening button when a sheet closes after the window widened', async () => {
    const viewport = installWidth(767);
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await openFrom(opener, user);
    act(() => {
      viewport.resize(768);
    });
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
        'data-overlay-variant',
        'bottom-sheet'
      );
    });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('returns focus to the opening button when a dialog closes after the window narrowed', async () => {
    const viewport = installWidth(768);
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await openFrom(opener, user);
    act(() => {
      viewport.resize(767);
    });
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
        'data-overlay-variant',
        'dialog'
      );
    });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it("moves focus to the page's main landmark when the opener is gone", async () => {
    const user = userEvent.setup();
    render(<RemovableOpenerHarness />);

    await openFrom(screen.getByRole('button', { name: 'Open' }), user);
    await user.click(screen.getByRole('button', { name: 'Remove opener' }));
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('main', { name: 'Page' })).toHaveFocus();
    });
  });

  it('gives a main landmark with no tabindex a tabindex of -1 while it holds focus', async () => {
    const user = userEvent.setup();
    render(<RemovableOpenerHarness />);

    await openFrom(screen.getByRole('button', { name: 'Open' }), user);
    await user.click(screen.getByRole('button', { name: 'Remove opener' }));
    await user.keyboard('{Escape}');

    const main = screen.getByRole('main', { name: 'Page' });
    await waitFor(() => {
      expect(main).toHaveFocus();
    });
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('removes the tabindex it gave the main landmark once the landmark loses focus', async () => {
    const user = userEvent.setup();
    render(<RemovableOpenerHarness />);

    await openFrom(screen.getByRole('button', { name: 'Open' }), user);
    await user.click(screen.getByRole('button', { name: 'Remove opener' }));
    await user.keyboard('{Escape}');

    const main = screen.getByRole('main', { name: 'Page' });
    await waitFor(() => {
      expect(main).toHaveFocus();
    });
    act(() => {
      main.blur();
    });
    expect(main).not.toHaveAttribute('tabindex');
  });

  it('leaves focus where the page moved it as the overlay closed', async () => {
    const user = userEvent.setup();
    render(<PageFocusHarness />);

    await openFrom(screen.getByRole('button', { name: 'Open' }), user);
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await afterCloseFocus();

    expect(screen.getByRole('textbox', { name: 'Composer' })).toHaveFocus();
  });

  it('returns focus to the opening button when the close button closes the dialog', async () => {
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await openFrom(opener, user);
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('returns focus to the opening button when a click outside closes the dialog', async () => {
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await openFrom(opener, user);
    await user.click(screen.getByTestId(TEST_IDS.overlayBackdrop));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('returns focus to the opening button when a confirm action closes the dialog', async () => {
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await openFrom(opener, user);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('returns focus to the opening button when a field in the overlay takes focus as it mounts', async () => {
    const user = userEvent.setup();
    render(<OpenerHarness autoFocusField />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await user.click(opener);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('keeps the tabindex a landmark already carried once it loses focus', async () => {
    const user = userEvent.setup();
    render(<RemovableOpenerHarness mainTabIndex={-1} />);

    await openFrom(screen.getByRole('button', { name: 'Open' }), user);
    await user.click(screen.getByRole('button', { name: 'Remove opener' }));
    await user.keyboard('{Escape}');

    const main = screen.getByRole('main', { name: 'Page' });
    await waitFor(() => {
      expect(main).toHaveFocus();
    });
    act(() => {
      main.blur();
    });
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it("moves focus to the page's main landmark when nothing held focus as the overlay opened", async () => {
    const { rerender } = render(<ProgrammaticHarness open={false} />);

    rerender(<ProgrammaticHarness open />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    rerender(<ProgrammaticHarness open={false} />);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('main', { name: 'Page' })).toHaveFocus();
    });
  });

  // Every page layout carries a `<main>`; a page without one must still close cleanly.
  it('closes without an error when the opener is gone and the page has no main landmark', async () => {
    const user = userEvent.setup();
    render(<RemovableOpenerHarness withMain={false} />);

    await openFrom(screen.getByRole('button', { name: 'Open' }), user);
    await user.click(screen.getByRole('button', { name: 'Remove opener' }));
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // A throw from the return runs on Radix's timer, where vitest reports it against this test.
    await afterCloseFocus();
  });

  it("returns focus to the menu's button when the menu item that opened the overlay is gone", async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);

    await openFrom(screen.getByRole('menuitem', { name: 'Rename' }), user);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More options' })).toHaveFocus();
    });
  });

  it("returns focus to the button a title-named menu's enclosing mark names", async () => {
    const user = userEvent.setup();
    render(<MenuHarness naming="title" />);

    await openFrom(screen.getByRole('menuitem', { name: 'Rename' }), user);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More options' })).toHaveFocus();
    });
  });
});

describe("Overlay with a caller's close-focus handler", () => {
  let restoreAnimations: () => void;

  beforeEach(() => {
    restoreAnimations = stopSheetAnimations();
  });

  afterEach(() => {
    restoreAnimations();
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
  });

  const PRESENTATIONS = [
    { presentation: 'a dialog', width: 768 },
    { presentation: 'a bottom sheet', width: 767 },
  ] as const;

  it.each(PRESENTATIONS)(
    'runs the handler in place of its own return, as $presentation',
    async ({ width }) => {
      installWidth(width);
      const user = userEvent.setup();
      // Takes the close over and moves focus nowhere, so only the overlay's own return could
      // put focus back on the opener.
      const onCloseAutoFocus = vi.fn((event: Event) => {
        event.preventDefault();
      });
      render(<OpenerHarness onCloseAutoFocus={onCloseAutoFocus} />);
      const opener = screen.getByRole('button', { name: 'Open' });

      await openFrom(opener, user);
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      await afterCloseFocus();

      expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
      expect(opener).not.toHaveFocus();
    }
  );

  it.each(PRESENTATIONS)(
    'runs its own return when the caller passes none, as $presentation',
    async ({ width }) => {
      installWidth(width);
      const user = userEvent.setup();
      render(<OpenerHarness />);
      const opener = screen.getByRole('button', { name: 'Open' });

      await openFrom(opener, user);
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      await waitFor(() => {
        expect(opener).toHaveFocus();
      });
    }
  );
});
