import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, onTestFinished, vi } from 'vitest';
import { Settings } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { Menu } from './menu';
import { MenuContext } from './menu-context';
import { MenuItem } from './menu-item';
import { PortalContainerProvider } from '../primitives/portal-container';
import {
  DESKTOP,
  PHONE,
  installViewport,
  restoreViewport,
  stopSheetAnimations,
} from './menu-viewport.setup';

afterEach(() => {
  restoreViewport();
});

function MoreOptions(
  props: Readonly<Partial<React.ComponentProps<typeof Menu>> & { onSettings?: () => void }>
): React.JSX.Element {
  const { onSettings = vi.fn(), ...menuProps } = props;
  return (
    <Menu
      trigger={<button type="button">More</button>}
      title="More options"
      data-testid={TEST_IDS.moreOptionsMenu}
      {...menuProps}
    >
      <MenuItem icon={Settings} title="Settings" onSelect={onSettings} />
      <MenuItem title="Usage" onSelect={vi.fn()} />
    </Menu>
  );
}

async function openMenu(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'More' }));
  await screen.findByRole('menu');
  return user;
}

describe('Menu presentation', () => {
  it('opens anchored, with no dialog, at 768', async () => {
    installViewport(DESKTOP);
    render(<MoreOptions />);

    await openMenu();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens as a sheet dialog that contains the menu at 767', async () => {
    installViewport(PHONE);
    render(<MoreOptions />);

    await openMenu();

    expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('menu'));
  });

  it.each([PHONE, DESKTOP])('finds an item by its menuitem role at %i', async (width) => {
    installViewport(width);
    render(<MoreOptions />);

    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
  });

  it('stays anchored on a phone when phonePresentation is anchored', async () => {
    installViewport(390);
    render(<MoreOptions phonePresentation="anchored" />);

    await openMenu();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the sheet by its title and shows it as a heading by default', async () => {
    installViewport(PHONE);
    render(<MoreOptions />);

    await openMenu();

    expect(screen.getByRole('dialog')).toHaveAccessibleName('More options');
    expect(screen.getByRole('heading', { name: 'More options' })).toBeVisible();
  });

  it('shows a close button in the sheet title row by default', async () => {
    installViewport(PHONE);
    render(<MoreOptions />);

    await openMenu();

    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' })
    ).toBeInTheDocument();
  });

  it('shows no title row when sheetHeader is none', async () => {
    installViewport(PHONE);
    render(<MoreOptions sheetHeader="none" />);

    await openMenu();

    // Only the dialog's screen-reader name remains; setup loads no stylesheet, so the class is the signal.
    expect(screen.getByRole('heading', { name: 'More options' })).toHaveClass('sr-only');
  });

  it('shows no close button when sheetHeader is none', async () => {
    installViewport(PHONE);
    render(<MoreOptions sheetHeader="none" />);

    await openMenu();

    expect(
      within(screen.getByRole('dialog')).queryByRole('button', { name: 'Close' })
    ).not.toBeInTheDocument();
  });

  it('still names the sheet by its title when sheetHeader is none', async () => {
    installViewport(PHONE);
    render(<MoreOptions sheetHeader="none" />);

    await openMenu();

    expect(screen.getByRole('dialog')).toHaveAccessibleName('More options');
  });

  it.each([PHONE, DESKTOP])('places data-testid on the menu list at %i', async (width) => {
    installViewport(width);
    render(<MoreOptions />);

    await openMenu();

    expect(screen.getByTestId(TEST_IDS.moreOptionsMenu)).toBe(screen.getByRole('menu'));
  });

  it('keeps its presentation while open when the window crosses 768', async () => {
    const resize = installViewport(PHONE);
    render(<MoreOptions />);
    await openMenu();

    act(() => {
      resize(DESKTOP);
    });

    expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('menu'));
  });

  it('keeps a closing sheet a sheet when the window widens as it closes', async () => {
    const resize = installViewport(PHONE);
    render(<MoreOptions />);
    const user = await openMenu();
    await user.keyboard('{Escape}');

    act(() => {
      resize(DESKTOP);
    });

    // The sheet's exit animation never ends in the test DOM, so a sheet still drawn stays mounted.
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument();
  });

  it('reads the width again on the next open', async () => {
    const resize = installViewport(PHONE);
    // The closed sheet leaves the page, and with it the scrim's hold on the trigger.
    const restoreAnimations = stopSheetAnimations();
    onTestFinished(restoreAnimations);
    render(<MoreOptions />);
    const user = await openMenu();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More', hidden: true })).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });

    act(() => {
      resize(DESKTOP);
    });
    await openMenu();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Menu floor', () => {
  it('sets a 12rem floor on the anchored menu when minWidth is 12rem', async () => {
    installViewport(DESKTOP);
    render(<MoreOptions minWidth="12rem" />);

    await openMenu();

    expect(screen.getByRole('menu')).toHaveClass('min-w-48');
  });

  it('sets a 16rem floor on the anchored menu, capped a rem inside the viewport, when minWidth is 16rem', async () => {
    installViewport(DESKTOP);
    render(<MoreOptions minWidth="16rem" />);

    await openMenu();

    expect(screen.getByRole('menu')).toHaveClass('min-w-[min(16rem,calc(100vw-1rem))]');
  });

  it('sets no floor of its own when no minWidth is given', async () => {
    installViewport(DESKTOP);
    render(<MoreOptions />);

    await openMenu();

    expect(screen.getByRole('menu')).not.toHaveClass('min-w-48');
    expect(screen.getByRole('menu')).not.toHaveClass('min-w-[min(16rem,calc(100vw-1rem))]');
  });
});

describe('Menu open state', () => {
  it('opens when a controlled open is true', async () => {
    installViewport(DESKTOP);
    render(<MoreOptions open onOpenChange={vi.fn()} />);

    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('asks to open through onOpenChange when its trigger is pressed', async () => {
    installViewport(DESKTOP);
    const onOpenChange = vi.fn();
    render(<MoreOptions open={false} onOpenChange={onOpenChange} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('stays closed while a controlled open is false', async () => {
    installViewport(PHONE);
    render(<MoreOptions open={false} onOpenChange={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('tells a sheet trigger it opens a dialog', () => {
    installViewport(PHONE);
    render(<MoreOptions />);

    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('marks a sheet trigger expanded while the sheet is open', async () => {
    installViewport(PHONE);
    render(<MoreOptions />);

    await openMenu();

    expect(screen.getByRole('button', { name: 'More', hidden: true })).toHaveAttribute(
      'data-state',
      'open'
    );
  });
});

interface StubBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const VIEWPORT: StubBox = { left: 0, top: 0, width: 1024, height: 768 };

/** Gives the trigger, the anchor and the open menu the boxes a laid-out page would. */
function stubBoxes(boxes: Readonly<{ trigger: StubBox; anchor: StubBox; menu: StubBox }>): void {
  const toRect = ({ left, top, width, height }: StubBox): DOMRect =>
    DOMRect.fromRect({ x: left, y: top, width, height });
  const isMenuBox = (element: HTMLElement): boolean =>
    'radixPopperContentWrapper' in element.dataset;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ): DOMRect {
    if (this.textContent === 'More' && this.tagName === 'BUTTON') return toRect(boxes.trigger);
    if (this.dataset['testid'] === 'anchor-box') return toRect(boxes.anchor);
    if (isMenuBox(this)) return toRect(boxes.menu);
    if (this.getAttribute('role') === 'menu') return toRect(boxes.menu);
    if (this === document.documentElement || this === document.body) return toRect(VIEWPORT);
    return toRect({ left: 0, top: 0, width: 0, height: 0 });
  });
  // The positioning reads the page's size from the root's client box and the menu's from its
  // offset box.
  const sizes = [
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return this === document.documentElement ? VIEWPORT.width : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return this === document.documentElement ? VIEWPORT.height : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return isMenuBox(this) ? boxes.menu.width : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return isMenuBox(this) ? boxes.menu.height : 0;
    }),
  ];
  onTestFinished(() => {
    spy.mockRestore();
    for (const size of sizes) size.mockRestore();
  });
}

function AnchoredMoreOptions(
  props: Readonly<Partial<React.ComponentProps<typeof Menu>>>
): React.JSX.Element {
  const anchor = React.useRef<HTMLDivElement>(null);
  return (
    <div ref={anchor} data-testid="anchor-box">
      <MoreOptions align="start" anchor={{ element: anchor, offset: '0.5rem' }} {...props} />
    </div>
  );
}

/** Where the positioning wrapper placed the open menu, as its translate's x and y. */
async function placedAt(): Promise<{ x: number; y: number }> {
  const menu = await screen.findByRole('menu');
  const wrapper = menu.closest<HTMLElement>('[data-radix-popper-content-wrapper]');
  let placed: { x: number; y: number } | undefined;
  await waitFor(() => {
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(wrapper?.style.transform ?? '');
    expect(match).not.toBeNull();
    placed = { x: Number(match?.[1]), y: Number(match?.[2]) };
  });
  if (placed === undefined) throw new Error('the menu was never placed');
  return placed;
}

describe('Menu anchor', () => {
  // The root font is 16px here, so the 0.5rem offset is 8px.
  const TRIGGER: StubBox = { left: 100, top: 300, width: 34, height: 34 };
  const ANCHOR: StubBox = { left: 90, top: 200, width: 600, height: 142 };

  it('opens its offset below the anchor instead of below its trigger', async () => {
    installViewport(DESKTOP);
    stubBoxes({
      trigger: TRIGGER,
      anchor: ANCHOR,
      menu: { left: 0, top: 0, width: 192, height: 100 },
    });
    render(<AnchoredMoreOptions />);

    await openMenu();

    const { y } = await placedAt();

    expect(y).toBe(342 + 8);
  });

  it("starts at the anchor's left edge instead of its trigger's", async () => {
    installViewport(DESKTOP);
    stubBoxes({
      trigger: TRIGGER,
      anchor: ANCHOR,
      menu: { left: 0, top: 0, width: 192, height: 100 },
    });
    render(<AnchoredMoreOptions />);

    await openMenu();

    const { x } = await placedAt();

    expect(x).toBe(90);
  });

  it("ends at the anchor's right edge when aligned to the end", async () => {
    installViewport(DESKTOP);
    stubBoxes({
      trigger: TRIGGER,
      anchor: ANCHOR,
      menu: { left: 0, top: 0, width: 192, height: 100 },
    });
    render(<AnchoredMoreOptions align="end" />);

    await openMenu();

    const { x } = await placedAt();

    expect(x).toBe(690 - 192);
  });

  it('flips to sit its offset above the anchor when there is no room below', async () => {
    installViewport(DESKTOP);
    const low = { trigger: { ...TRIGGER, top: 700 }, anchor: { ...ANCHOR, top: 600 } };
    stubBoxes({ ...low, menu: { left: 0, top: 0, width: 192, height: 300 } });
    render(<AnchoredMoreOptions />);

    await openMenu();

    await waitFor(async () => {
      const { y } = await placedAt();
      expect(y).toBe(600 - 8 - 300);
    });
  });

  it('opens its offset above the anchor when it prefers the top', async () => {
    installViewport(DESKTOP);
    stubBoxes({
      trigger: TRIGGER,
      anchor: ANCHOR,
      menu: { left: 0, top: 0, width: 192, height: 100 },
    });
    render(<AnchoredMoreOptions side="top" />);

    await openMenu();

    const { y } = await placedAt();

    expect(y).toBe(200 - 8 - 100);
  });

  it('opens below its trigger, as without an anchor, when the anchor is not in the page', async () => {
    installViewport(DESKTOP);
    stubBoxes({
      trigger: TRIGGER,
      anchor: ANCHOR,
      menu: { left: 0, top: 0, width: 192, height: 100 },
    });
    const detached = { current: null };
    render(<MoreOptions align="start" anchor={{ element: detached, offset: '0.5rem' }} />);

    await openMenu();

    expect(await placedAt()).toEqual({ x: 100, y: 334 + 4 });
  });

  it('opens 4px below its trigger, at its left edge, without an anchor', async () => {
    installViewport(DESKTOP);
    stubBoxes({
      trigger: TRIGGER,
      anchor: ANCHOR,
      menu: { left: 0, top: 0, width: 192, height: 100 },
    });
    render(<MoreOptions align="start" />);

    await openMenu();

    expect(await placedAt()).toEqual({ x: 100, y: 334 + 4 });
  });

  it('keeps the sheet below 768 whatever the anchor', async () => {
    installViewport(PHONE);
    render(<AnchoredMoreOptions />);

    await openMenu();

    expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('menu'));
  });
});

describe('Menu opened by its caller', () => {
  // The root font is 16px here, so the 0.5rem offset is 8px.
  const TRIGGER: StubBox = { left: 100, top: 300, width: 34, height: 34 };
  const ANCHOR: StubBox = { left: 90, top: 200, width: 600, height: 142 };
  const MENU: StubBox = { left: 0, top: 0, width: 192, height: 100 };

  it('opens its offset below the anchor when a controlled open is set', async () => {
    installViewport(DESKTOP);
    stubBoxes({ trigger: TRIGGER, anchor: ANCHOR, menu: MENU });
    render(<AnchoredMoreOptions open onOpenChange={vi.fn()} />);

    expect(await placedAt()).toEqual({ x: 90, y: 342 + 8 });
  });

  it('opens against the anchor when its trigger draws no box', async () => {
    installViewport(DESKTOP);
    stubBoxes({ trigger: { left: 0, top: 0, width: 0, height: 0 }, anchor: ANCHOR, menu: MENU });
    render(<AnchoredMoreOptions open onOpenChange={vi.fn()} />);

    expect(await placedAt()).toEqual({ x: 90, y: 342 + 8 });
  });
});

/** The menu and, beside it, a button that stands in for another control on the page. */
function MenuWithFallback(
  props: Readonly<Partial<React.ComponentProps<typeof Menu>> & { initiallyOpen?: boolean }>
): React.JSX.Element {
  const { initiallyOpen = false, ...menuProps } = props;
  const fallback = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(initiallyOpen);
  return (
    <>
      <button ref={fallback} type="button">
        Elsewhere
      </button>
      <MoreOptions fallbackFocus={fallback} open={open} onOpenChange={setOpen} {...menuProps} />
    </>
  );
}

describe('Menu fallback focus', () => {
  it('returns focus to the fallback on close when its trigger is hidden', async () => {
    installViewport(DESKTOP);
    // A real engine gives a `display: none` element no boxes; this DOM gives every element one.
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
      this: HTMLElement
    ): DOMRectList {
      const boxes: DOMRect[] = this.hidden ? [] : [this.getBoundingClientRect()];
      return Object.assign(boxes, { item: (index: number) => boxes[index] ?? null });
    });
    onTestFinished(() => {
      rects.mockRestore();
    });
    render(
      <MenuWithFallback
        trigger={
          <button type="button" hidden>
            More
          </button>
        }
        initiallyOpen
      />
    );
    await screen.findByRole('menu');
    const user = userEvent.setup();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    });
  });

  it('returns focus to its trigger on close while the trigger is shown', async () => {
    installViewport(DESKTOP);
    render(<MenuWithFallback />);
    const user = await openMenu();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    });
  });
});

/** A control that takes focus as it appears, as a pane opened from a menu item does. */
function FocusOnMount(): React.JSX.Element {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <button ref={ref} type="button">
      Pane
    </button>
  );
}

/** A menu whose Open pane item, run after the menu closes, shows a control that takes focus. */
function MenuOpeningAPane(
  props: Readonly<{ onOpenPane?: (triggerExpanded: string | null) => void }>
): React.JSX.Element {
  const { onOpenPane = vi.fn() } = props;
  const [paneShown, setPaneShown] = React.useState(false);
  return (
    <>
      <Menu trigger={<button type="button">More</button>} title="More options">
        <MenuItem
          title="Open pane"
          runAfterClose
          onSelect={() => {
            const trigger = document.querySelector('[aria-haspopup]');
            onOpenPane(trigger?.getAttribute('aria-expanded') ?? null);
            setPaneShown(true);
          }}
        />
      </Menu>
      {paneShown && <FocusOnMount />}
    </>
  );
}

describe('Menu item that runs after the menu closes', () => {
  it('leaves focus where its action placed it outside the menu', async () => {
    installViewport(DESKTOP);
    render(<MenuOpeningAPane />);
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Open pane' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pane' })).toHaveFocus();
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('runs its action once the anchored menu has closed', async () => {
    installViewport(DESKTOP);
    const onOpenPane = vi.fn();
    render(<MenuOpeningAPane onOpenPane={onOpenPane} />);
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Open pane' }));

    await waitFor(() => {
      expect(onOpenPane).toHaveBeenCalledWith('false');
    });
  });

  it('runs its action once the sheet has closed', async () => {
    installViewport(PHONE);
    onTestFinished(stopSheetAnimations());
    const onOpenPane = vi.fn();
    render(<MenuOpeningAPane onOpenPane={onOpenPane} />);
    const user = await openMenu();

    // Chosen by keyboard: a pointer release on the sheet reaches its drag handling, which needs
    // layout this DOM does not compute.
    screen.getByRole('menuitem', { name: 'Open pane' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onOpenPane).toHaveBeenCalledWith('false');
    });
  });
});

/** Gives the anchored menu an exit animation, as the app's styles do outside reduced motion. */
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

/** Ends the exit animation an element is running, as the engine does when it finishes. */
function finishExit(element: Element): void {
  fireEvent.animationEnd(element, { animationName: getComputedStyle(element).animationName });
}

/** Lets every task queued so far run; the order of work is the point, not the time. */
async function drainTasks(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

describe('Menu item that runs after the menu closes, while the menu animates out', () => {
  it('waits for the anchored menu to finish closing', async () => {
    installViewport(DESKTOP);
    animateMenuExit();
    const onOpenPane = vi.fn();
    render(<MenuOpeningAPane onOpenPane={onOpenPane} />);
    const user = await openMenu();
    const content = screen.getByRole('menu');

    await user.click(screen.getByRole('menuitem', { name: 'Open pane' }));
    await drainTasks();
    expect(onOpenPane).not.toHaveBeenCalled();

    act(() => {
      finishExit(content);
    });

    await waitFor(() => {
      expect(onOpenPane).toHaveBeenCalledTimes(1);
    });
  });

  it('waits for the sheet to finish closing', async () => {
    installViewport(PHONE);
    const onOpenPane = vi.fn();
    render(<MenuOpeningAPane onOpenPane={onOpenPane} />);
    const user = await openMenu();
    const drawer = document.querySelector('[data-vaul-drawer]');
    if (drawer === null) throw new Error('the sheet drew no drawer');

    // Chosen by keyboard: a pointer release on the sheet reaches its drag handling, which needs
    // layout this DOM does not compute.
    screen.getByRole('menuitem', { name: 'Open pane' }).focus();
    await user.keyboard('{Enter}');
    await drainTasks();
    expect(onOpenPane).not.toHaveBeenCalled();

    act(() => {
      finishExit(drawer);
    });

    await waitFor(() => {
      expect(onOpenPane).toHaveBeenCalledTimes(1);
    });
  });

  it('returns focus to the trigger before its action runs', async () => {
    installViewport(DESKTOP);
    let focusedAtAction: Element | null = null;
    render(
      <MenuOpeningAPane
        onOpenPane={() => {
          focusedAtAction = document.activeElement;
        }}
      />
    );
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Open pane' }));

    await waitFor(() => {
      expect(focusedAtAction).toBe(screen.getByRole('button', { name: 'More' }));
    });
  });
});

describe('Menu item that runs after the menu closes, outside a Menu', () => {
  it('refuses to render, since nothing would run its action', () => {
    // React reports the render error to the console before the throw reaches the test.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => {
      consoleError.mockRestore();
    });

    expect(() =>
      render(
        <MenuContext value={{ presentation: 'sheet', close: vi.fn() }}>
          <MenuItem title="Open pane" runAfterClose onSelect={vi.fn()} />
        </MenuContext>
      )
    ).toThrow('An item that runs after its menu closes renders only inside a Menu');
  });
});

function portalTarget(): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  onTestFinished(() => {
    target.remove();
  });
  return target;
}

describe('Menu portal', () => {
  it('portals the anchored menu into the element its provider gives, at 768', async () => {
    installViewport(DESKTOP);
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <MoreOptions open onOpenChange={vi.fn()} />
      </PortalContainerProvider>
    );

    expect(target).toContainElement(await screen.findByRole('menu'));
  });

  it('portals the sheet into the element its provider gives, at 767', async () => {
    installViewport(PHONE);
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <MoreOptions open onOpenChange={vi.fn()} />
      </PortalContainerProvider>
    );

    expect(target).toContainElement(await screen.findByRole('dialog'));
  });
});
