import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, onTestFinished, vi } from 'vitest';
import { Popover } from './popover';
import { PortalContainerProvider } from '../primitives/portal-container';

type ChangeListener = (event: MediaQueryListEvent) => void;

interface MediaListStub {
  readonly matches: boolean;
  readonly media: string;
  readonly addEventListener: (type: string, listener: ChangeListener) => void;
  readonly removeEventListener: (type: string, listener: ChangeListener) => void;
}

interface Viewport {
  readonly resize: (width: number) => void;
}

const originalMatchMedia = globalThis.matchMedia;

/** Stubs `matchMedia` for a window `width` wide with a fine pointer. */
function installViewport(initialWidth: number): Viewport {
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

/**
 * vaul animates the sheet out and Radix unmounts it on `animationend`, which happy-dom never
 * fires, so a closed sheet would otherwise stay in the document.
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

/**
 * A click with no pointer events around it. vaul reads the sheet's computed transform when a
 * pointer is released inside it, which happy-dom does not provide, so a full pointer sequence
 * throws inside vaul's handler rather than in anything under test.
 */
function clickInsideSheet(element: HTMLElement): void {
  fireEvent.click(element);
}

let restoreAnimations: () => void = () => {};

beforeEach(() => {
  restoreAnimations = stopSheetAnimations();
});

afterEach(() => {
  restoreAnimations();
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

function Sample(props: Readonly<Partial<React.ComponentProps<typeof Popover>>>): React.JSX.Element {
  return (
    <Popover trigger={<button type="button">Aspect</button>} title="Aspect ratio" {...props}>
      <button type="button">1:1</button>
    </Popover>
  );
}

async function openFromTrigger(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Aspect' }));
  return screen.findByRole('dialog');
}

describe('Popover from 768', () => {
  it('opens from its trigger as a dialog named by its title', async () => {
    installViewport(768);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(dialog).toHaveAccessibleName('Aspect ratio');
  });

  it('opens anchored rather than as a sheet', async () => {
    installViewport(768);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(dialog).toHaveAttribute('data-slot', 'popover-content');
  });

  it('draws no visible title row', async () => {
    installViewport(768);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(within(dialog).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('is 18rem wide by default', async () => {
    installViewport(1440);
    render(<Sample />);

    expect(await openFromTrigger()).toHaveClass('w-72');
  });

  it('is 23rem wide at width md', async () => {
    installViewport(1440);
    render(<Sample width="md" />);

    expect(await openFromTrigger()).toHaveClass('w-92');
  });

  it('is 25rem wide at width lg', async () => {
    installViewport(1440);
    render(<Sample width="lg" />);

    expect(await openFromTrigger()).toHaveClass('w-100');
  });

  it('narrows to the room it has', async () => {
    installViewport(1440);
    render(<Sample width="lg" />);

    expect(await openFromTrigger()).toHaveClass('max-w-(--radix-popover-content-available-width)');
  });

  it('caps its height to the room on its side and scrolls inside it', async () => {
    installViewport(1440);
    render(<Sample />);

    expect(await openFromTrigger()).toHaveClass(
      'max-h-[max(10rem,var(--radix-popover-content-available-height))]',
      'overflow-y-auto'
    );
  });

  it('lays its children out as a column, so a child with min-h-0 can take the scroll', async () => {
    installViewport(1440);
    render(<Sample />);

    expect(await openFromTrigger()).toHaveClass('flex', 'flex-col');
  });

  it('keeps every other child at its own height, so a tall body still scrolls the popover', async () => {
    installViewport(1440);
    render(<Sample />);

    expect(await openFromTrigger()).toHaveClass('*:shrink-0');
  });

  it('places its test id on the content', async () => {
    installViewport(1440);
    render(<Sample data-testid="ratio-popover" />);

    expect(await openFromTrigger()).toHaveAttribute('data-testid', 'ratio-popover');
  });

  it('opens on its preferred side', async () => {
    installViewport(1440);
    render(<Sample side="top" />);

    expect(await openFromTrigger()).toHaveAttribute('data-side', 'top');
  });

  it('opens from a controlled open with no trigger click', async () => {
    installViewport(1440);
    render(<Sample open onOpenChange={vi.fn()} />);

    expect(await screen.findByRole('dialog')).toHaveAccessibleName('Aspect ratio');
  });

  it('reports a dismissal through onOpenChange', async () => {
    installViewport(1440);
    const onOpenChange = vi.fn();
    render(<Sample open onOpenChange={onOpenChange} />);
    await screen.findByRole('dialog');

    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens against an anchor element while its trigger stays in place', async () => {
    installViewport(1440);
    const anchor = document.createElement('span');
    document.body.append(anchor);
    render(<Sample anchor={anchor} open onOpenChange={vi.fn()} />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aspect' })).toBeInTheDocument();
    anchor.remove();
  });

  it('closes from Escape and returns focus to the trigger', async () => {
    installViewport(1440);
    render(<Sample />);
    await openFromTrigger();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Aspect' })).toHaveFocus();
  });
});

describe('Popover below 768', () => {
  it('opens as a bottom sheet', async () => {
    installViewport(767);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(dialog).toHaveAttribute('data-overlay-variant', 'bottom-sheet');
  });

  it('shows its title row', async () => {
    installViewport(767);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(within(dialog).getByRole('heading', { name: 'Aspect ratio' })).toBeInTheDocument();
  });

  it('is named by its title', async () => {
    installViewport(767);
    render(<Sample />);

    expect(await openFromTrigger()).toHaveAccessibleName('Aspect ratio');
  });

  it('shows a close button', async () => {
    installViewport(767);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('sets its text at 0.875rem, as it does anchored', async () => {
    installViewport(767);
    render(<Sample data-testid="ratio-popover" />);

    const dialog = await openFromTrigger();

    expect(within(dialog).getByTestId('ratio-popover')).toHaveClass('text-sm');
  });

  it('marks its close button as the overlay close', async () => {
    installViewport(767);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveAttribute(
      'data-slot',
      'overlay-close'
    );
  });

  it('holds its children', async () => {
    installViewport(767);
    render(<Sample />);

    const dialog = await openFromTrigger();

    expect(within(dialog).getByRole('button', { name: '1:1' })).toBeInTheDocument();
  });

  it('places its test id on the content', async () => {
    installViewport(767);
    render(<Sample data-testid="ratio-popover" />);

    const dialog = await openFromTrigger();

    expect(within(dialog).getByTestId('ratio-popover')).toHaveTextContent('1:1');
  });

  it('tells assistive technology the trigger opens a dialog', () => {
    installViewport(767);
    render(<Sample />);

    expect(screen.getByRole('button', { name: 'Aspect' })).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    );
  });

  it('marks the trigger expanded while the sheet is open', async () => {
    installViewport(767);
    render(<Sample />);

    await openFromTrigger();

    expect(screen.getByRole('button', { name: 'Aspect', hidden: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it("still runs the trigger's own click handler", async () => {
    installViewport(767);
    const onClick = vi.fn();
    render(
      <Popover
        trigger={
          <button type="button" onClick={onClick}>
            Aspect
          </button>
        }
        title="Aspect ratio"
      >
        <p>Body</p>
      </Popover>
    );

    await openFromTrigger();

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('closes from its close button and returns focus to the trigger', async () => {
    installViewport(767);
    render(<Sample />);
    const dialog = await openFromTrigger();

    clickInsideSheet(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Aspect' })).toHaveFocus();
  });

  it('opens as a sheet from a controlled open', async () => {
    installViewport(390);
    render(<Sample open onOpenChange={vi.fn()} />);

    expect(await screen.findByRole('dialog')).toHaveAttribute(
      'data-overlay-variant',
      'bottom-sheet'
    );
  });

  it('reports the close button through onOpenChange', async () => {
    installViewport(390);
    const onOpenChange = vi.fn();
    render(<Sample open onOpenChange={onOpenChange} />);
    const dialog = await screen.findByRole('dialog');

    clickInsideSheet(within(dialog).getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Popover across 768', () => {
  it('keeps the sheet while open when the window widens', async () => {
    const viewport = installViewport(390);
    render(<Sample />);
    await openFromTrigger();

    act(() => {
      viewport.resize(1440);
    });

    expect(screen.getByRole('dialog')).toHaveAttribute('data-overlay-variant', 'bottom-sheet');
  });

  it('keeps the anchored popover while open when the window narrows', async () => {
    const viewport = installViewport(1440);
    render(<Sample />);
    await openFromTrigger();

    act(() => {
      viewport.resize(390);
    });

    expect(screen.getByRole('dialog')).toHaveAttribute('data-slot', 'popover-content');
  });

  it('opens anchored after a sheet closes and the window widens', async () => {
    const viewport = installViewport(390);
    render(<Sample />);
    const sheet = await openFromTrigger();
    clickInsideSheet(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    act(() => {
      viewport.resize(1440);
    });

    expect(await openFromTrigger()).toHaveAttribute('data-slot', 'popover-content');
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

describe('Popover portal', () => {
  it('portals the anchored popover into the element its provider gives, from 768', async () => {
    installViewport(1440);
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Sample open onOpenChange={vi.fn()} />
      </PortalContainerProvider>
    );

    expect(target).toContainElement(await screen.findByRole('dialog'));
  });

  it('portals the sheet into the element its provider gives, below 768', async () => {
    installViewport(767);
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <Sample open onOpenChange={vi.fn()} />
      </PortalContainerProvider>
    );

    expect(target).toContainElement(await screen.findByRole('dialog'));
  });
});
