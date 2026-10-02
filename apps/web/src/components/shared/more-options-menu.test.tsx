import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { MOBILE_BREAKPOINT } from '@hushbox/shared';
import { useAccessibilityPanelStore } from '@/stores/ui/accessibility-panel';
import { MoreOptionsMenu } from './more-options-menu';

const originalMatchMedia = globalThis.matchMedia;

/** The widest window that presents the menu as a sheet. */
const PHONE = MOBILE_BREAKPOINT - 1;
/** The narrowest window that presents the menu anchored to its trigger. */
const DESKTOP = MOBILE_BREAKPOINT;

/** Answers the band's width queries for a window `width` wide, with a fine pointer. */
function installViewport(width: number): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: maxWidth?.[1] !== undefined && width <= Number(maxWidth[1]),
        media: query,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      };
      // The band and pointer hooks read only `matches` and the listener pair.
      return list as MediaQueryList;
    },
  });
}

/**
 * vaul unmounts a sheet on `animationend`, which this DOM never fires; with the animation
 * stopped the sheet leaves the page as it closes, and hands focus back, as it does in a browser.
 */
function stopSheetAnimations(): void {
  const style = document.createElement('style');
  style.textContent =
    '[data-vaul-drawer], [data-vaul-overlay] { animation-name: none !important; }';
  document.head.append(style);
  onTestFinished(() => {
    style.remove();
  });
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'More options' });
}

async function openMenu(width: number): Promise<ReturnType<typeof userEvent.setup>> {
  installViewport(width);
  render(<MoreOptionsMenu />);
  const user = userEvent.setup();
  trigger().focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('menu');
  return user;
}

describe('MoreOptionsMenu', () => {
  beforeEach(() => {
    useAccessibilityPanelStore.setState({ open: false });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
  });

  it('draws a trigger named More options', () => {
    installViewport(DESKTOP);
    render(<MoreOptionsMenu />);

    expect(trigger()).toBeInTheDocument();
  });

  it('draws the trigger as an icon button with no visible text', () => {
    installViewport(DESKTOP);
    render(<MoreOptionsMenu />);

    expect(trigger()).toHaveTextContent('');
  });

  it.each([
    ['at 767', PHONE],
    ['at 768', DESKTOP],
  ])('holds the Accessibility item alone %s', async (_label, width) => {
    await openMenu(width);

    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Accessibility']);
  });

  it.each([
    ['at 767', PHONE],
    ['at 768', DESKTOP],
  ])('finds the Accessibility item by the same role locator %s', async (_label, width) => {
    await openMenu(width);

    expect(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Accessibility' })
    ).toBeInTheDocument();
  });

  it('opens as a dialog titled More options below 768', async () => {
    await openMenu(PHONE);

    expect(screen.getByRole('dialog', { name: 'More options' })).toBeInTheDocument();
  });

  it('opens anchored, with no dialog, from 768', async () => {
    await openMenu(DESKTOP);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['at 767', PHONE],
    ['at 768', DESKTOP],
  ])('opens the accessibility panel when Accessibility is chosen %s', async (_label, width) => {
    // The panel opens once the menu has finished closing; the sheet finishes only once its
    // animation is stopped.
    stopSheetAnimations();
    const user = await openMenu(width);

    screen.getByRole('menuitem', { name: 'Accessibility' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(useAccessibilityPanelStore.getState().open).toBe(true);
    });
  });

  it('leaves the accessibility panel closed while the menu only opens', async () => {
    await openMenu(DESKTOP);

    expect(useAccessibilityPanelStore.getState().open).toBe(false);
  });

  it('closes the menu when Accessibility is chosen', async () => {
    const user = await openMenu(DESKTOP);

    screen.getByRole('menuitem', { name: 'Accessibility' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('focus on close', () => {
    it.each([
      ['at 767', PHONE],
      ['at 768', DESKTOP],
    ])('returns to the trigger when Escape closes the menu %s', async (_label, width) => {
      stopSheetAnimations();
      const user = await openMenu(width);

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(trigger()).toHaveFocus();
      });
    });
  });
});
