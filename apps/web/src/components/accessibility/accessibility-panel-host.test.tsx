import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { MoreOptionsMenu } from '@/components/shared/more-options-menu';
import { RightPaneHostContext } from '@/components/shared/right-pane';
import { useAccessibilityPanelStore } from '@/stores/ui/accessibility-panel';
import { useRightPane } from '@/stores/ui/right-pane';
import { AccessibilityPanelHost } from './accessibility-panel-host';

// The panel's subpath pulls the speech engine; the host only places it.
vi.mock('@hushbox/ui/accessibility/panel', () => ({
  AccessibilityPanel: ({ host }: Readonly<{ host: string }>): React.JSX.Element => (
    <div role="group" aria-label="Accessibility settings" data-host={host}>
      <button type="button">Reset all to defaults</button>
    </div>
  ),
}));

const originalMatchMedia = globalThis.matchMedia;

/** Narrows the window below 768px, where the panel takes its sheet form. */
function stubPhoneWidth(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === '(max-width: 767px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

/** Stands in for the shell: the page, the opener, and the slot the pane portals into. */
function Shell(): React.JSX.Element {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  return (
    <RightPaneHostContext value={host}>
      <main>
        <button
          type="button"
          onClick={() => {
            useAccessibilityPanelStore.getState().setOpen(true);
          }}
        >
          More options
        </button>
      </main>
      <AccessibilityPanelHost />
      <div ref={setHost} />
    </RightPaneHostContext>
  );
}

function openFromStore(): void {
  act(() => {
    useAccessibilityPanelStore.getState().setOpen(true);
  });
}

function pane(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Accessibility' });
}

describe('AccessibilityPanelHost', () => {
  beforeEach(() => {
    useRightPane.setState({ active: null });
    useAccessibilityPanelStore.setState({ open: false });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('shows nothing while the panel is closed', () => {
    render(<Shell />);

    expect(screen.queryByRole('complementary', { name: 'Accessibility' })).not.toBeInTheDocument();
  });

  it('opens as a pane when the panel store opens', async () => {
    render(<Shell />);

    openFromStore();

    expect(pane()).toBeInTheDocument();
    // The panel loads lazily; waiting for it lets it settle inside the test.
    expect(
      await within(pane()).findByRole('group', { name: 'Accessibility settings' })
    ).toBeInTheDocument();
  });

  it('titles the pane Accessibility with a heading', () => {
    render(<Shell />);

    openFromStore();

    expect(
      within(pane()).getByRole('heading', { level: 2, name: 'Accessibility' })
    ).toBeInTheDocument();
  });

  it('draws the panel with the app layout inside the pane', async () => {
    render(<Shell />);

    openFromStore();

    expect(
      await within(pane()).findByRole('group', { name: 'Accessibility settings' })
    ).toHaveAttribute('data-host', 'app');
  });

  it('docks at 22rem on the page background from 768', () => {
    render(<Shell />);

    openFromStore();

    expect(pane()).toHaveClass('md:w-[22rem]', 'bg-background');
  });

  it('rises below 768 as a 62dvh sheet that leaves the page usable', () => {
    stubPhoneWidth();
    render(<Shell />);

    openFromStore();

    expect(pane()).toHaveClass('h-[62dvh]');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' })).not.toHaveAttribute('aria-hidden');
  });

  it('takes focus as it opens', async () => {
    const user = userEvent.setup();
    render(<Shell />);

    await user.click(screen.getByRole('button', { name: 'More options' }));

    expect(pane()).toHaveFocus();
  });

  it('closes on Escape and returns focus to its opener', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.click(screen.getByRole('button', { name: 'More options' }));
    expect(pane()).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('complementary', { name: 'Accessibility' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' })).toHaveFocus();
  });

  it('closes on its X and returns focus to its opener', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.click(screen.getByRole('button', { name: 'More options' }));

    await user.click(screen.getByRole('button', { name: 'Close accessibility' }));

    expect(screen.queryByRole('complementary', { name: 'Accessibility' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' })).toHaveFocus();
  });

  it('marks the panel closed once its pane closes', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    await user.click(screen.getByRole('button', { name: 'More options' }));

    await user.click(screen.getByRole('button', { name: 'Close accessibility' }));

    expect(useAccessibilityPanelStore.getState().open).toBe(false);
  });

  it('marks the panel closed when another pane takes the slot, so it can open again', () => {
    render(<Shell />);
    openFromStore();

    act(() => {
      useRightPane.getState().open('members');
    });
    expect(useAccessibilityPanelStore.getState().open).toBe(false);

    openFromStore();
    expect(pane()).toBeInTheDocument();
  });

  describe('opened from the More options menu', () => {
    /** The shell with the real More options menu in its header. */
    function ShellWithMenu(): React.JSX.Element {
      const [host, setHost] = React.useState<HTMLElement | null>(null);
      return (
        <RightPaneHostContext value={host}>
          <main>
            <MoreOptionsMenu />
          </main>
          <AccessibilityPanelHost />
          <div ref={setHost} />
        </RightPaneHostContext>
      );
    }

    /** vaul unmounts a sheet on `animationend`, which this DOM never fires unless told to. */
    function stopSheetAnimations(): void {
      const style = document.createElement('style');
      style.textContent =
        '[data-vaul-drawer], [data-vaul-overlay] { animation-name: none !important; }';
      document.head.append(style);
      onTestFinished(() => {
        style.remove();
      });
    }

    function moreOptions(): HTMLElement {
      return screen.getByRole('button', { name: 'More options' });
    }

    async function chooseAccessibility(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      moreOptions().focus();
      await user.keyboard('{Enter}');
      const item = await screen.findByRole('menuitem', { name: 'Accessibility' });
      item.focus();
      await user.keyboard('{Enter}');
      return user;
    }

    async function openFromMenu(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = await chooseAccessibility();
      await waitFor(() => {
        expect(pane()).toHaveFocus();
      });
      return user;
    }

    /** Gives the anchored menu the exit animation the app draws outside reduced motion. */
    function animateMenuExit(): void {
      const style = document.createElement('style');
      style.textContent =
        '[data-slot="dropdown-menu-content"][data-state="open"] { animation-name: menu-in; }' +
        '[data-slot="dropdown-menu-content"][data-state="closed"] { animation-name: menu-out; }';
      document.head.append(style);
      onTestFinished(() => {
        style.remove();
      });
    }

    /** Ends the exit animation an element runs, as the engine does when it finishes. */
    function finishExit(element: Element): void {
      act(() => {
        fireEvent.animationEnd(element, {
          animationName: getComputedStyle(element).animationName,
        });
      });
    }

    it('returns focus to More options after the docked pane, when the menu animates out', async () => {
      animateMenuExit();
      render(<ShellWithMenu />);
      const user = userEvent.setup();
      moreOptions().focus();
      await user.keyboard('{Enter}');
      const content = await screen.findByRole('menu');
      screen.getByRole('menuitem', { name: 'Accessibility' }).focus();
      await user.keyboard('{Enter}');
      finishExit(content);
      await waitFor(() => {
        expect(pane()).toHaveFocus();
      });

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(moreOptions()).toHaveFocus();
      });
    });

    it('returns focus to More options after the sheet, when the menu animates out', async () => {
      stubPhoneWidth();
      render(<ShellWithMenu />);
      const user = await chooseAccessibility();
      const drawer = document.querySelector('[data-vaul-drawer]');
      if (drawer === null) throw new Error('the menu drew no sheet');
      finishExit(drawer);
      await waitFor(() => {
        expect(pane()).toHaveFocus();
      });

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(moreOptions()).toHaveFocus();
      });
    });

    it('returns focus to More options when Escape closes the docked pane', async () => {
      render(<ShellWithMenu />);
      const user = await openFromMenu();

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(moreOptions()).toHaveFocus();
      });
    });

    it('returns focus to More options when Escape closes the sheet', async () => {
      stubPhoneWidth();
      stopSheetAnimations();
      render(<ShellWithMenu />);
      const user = await openFromMenu();

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(moreOptions()).toHaveFocus();
      });
    });
  });
});
