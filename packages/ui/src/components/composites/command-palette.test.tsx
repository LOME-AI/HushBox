import * as React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Search, Settings } from 'lucide-react';
import { TEST_IDS, TOUCH_QUERY } from '@hushbox/shared';
import {
  CommandPalette,
  buildSections,
  type PaletteItem,
  type PaletteSection,
} from './command-palette';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../primitives/dialog';

const PALETTE = 'palette';
const PALETTE_INPUT = 'palette-input';
const PALETTE_OPTION = 'palette-option';

interface Item extends PaletteItem {
  readonly target: string;
}

const SCREENS: PaletteSection<Item> = {
  heading: 'Screens',
  items: [
    { id: 'dashboard', label: 'Dashboard', target: '/dashboard' },
    { id: 'jobs', label: 'Jobs', hint: '/jobs', target: '/jobs' },
  ],
};

const OPS: PaletteSection<Item> = {
  heading: 'Ops',
  items: [{ id: 'lock', label: 'Lock account', hint: 'user.lock', target: 'user.lock' }],
};

const GO_TO: PaletteSection<Item> = {
  heading: 'Go to',
  items: [
    { id: 'settings', label: 'Settings', icon: Settings, meta: 'Today', target: '/settings' },
    { id: 'search', label: 'Search', icon: Search, target: '/search' },
  ],
};

const originalMatchMedia = globalThis.matchMedia;

/** Stubs `matchMedia` for a window `width` wide under the given primary pointer. */
function setWindowWidth(width: number, pointer: 'fine' | 'coarse' = 'fine'): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches:
          maxWidth?.[1] === undefined
            ? query === TOUCH_QUERY && pointer === 'coarse'
            : width <= Number(maxWidth[1]),
        media: query,
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

function Harness({
  onRun,
  sections,
  empty,
  footer,
  appearance,
  openerSurvives = true,
}: Readonly<{
  onRun: (item: Item) => void;
  sections?: (query: string) => readonly PaletteSection<Item>[];
  empty?: React.ReactNode;
  footer?: React.ReactNode;
  appearance?: 'product' | 'plain';
  /** A caller that takes the control away in the very click that opens. */
  openerSurvives?: boolean;
}>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      {(openerSurvives || !open) && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Open
        </button>
      )}
      <CommandPalette
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        sections={sections ?? (() => [SCREENS, OPS])}
        onRun={onRun}
        empty={empty}
        footer={footer}
        {...(appearance !== undefined && { appearance })}
        title="Command palette"
        description="Search screens and ops. Use the arrow keys and Enter."
        placeholder="Search screens and ops"
        testId={PALETTE}
        inputTestId={PALETTE_INPUT}
        optionTestId={PALETTE_OPTION}
      />
    </div>
  );
}

async function open(
  user: ReturnType<typeof userEvent.setup>
): Promise<ReturnType<typeof screen.getByTestId>> {
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => {
    expect(screen.getByTestId(PALETTE)).toBeInTheDocument();
  });
  return screen.getByTestId(PALETTE);
}

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    render(<Harness onRun={vi.fn()} />);

    expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
  });

  it('renders every section with its items and focuses the input', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);

    expect(within(palette).getByText('Screens')).toBeInTheDocument();
    expect(within(palette).getByText('Dashboard')).toBeInTheDocument();
    expect(within(palette).getByText('Lock account')).toBeInTheDocument();
    expect(screen.getByTestId(PALETTE_INPUT)).toHaveFocus();
  });

  it('renders an item hint beside its label and omits it when absent', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    const palette = await open(user);

    expect(within(palette).getByText('/jobs')).toBeInTheDocument();
    const dashboard = within(palette).getByText('Dashboard').closest('[role="option"]');
    expect(dashboard?.textContent).toBe('Dashboard');
  });

  // The hint is the id a reader scans for, so it must keep its intrinsic width
  // rather than being squeezed by a long label until it breaks mid-token.
  it('keeps the hint unshrinkable against a shrinkable label', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    const palette = await open(user);
    const hint = within(palette).getByText('/jobs');
    const label = within(palette).getByText('Jobs');

    expect(hint.className.split(/\s+/)).toContain('shrink-0');
    expect(label.className.split(/\s+/)).toContain('min-w-0');
  });

  it('asks the caller for sections on every keystroke', async () => {
    const user = userEvent.setup();
    const sections = vi.fn((query: string) =>
      query === ''
        ? [SCREENS]
        : [{ heading: 'Filtered', items: [{ id: 'q', label: query, target: query }] }]
    );
    render(<Harness onRun={vi.fn()} sections={sections} />);

    const palette = await open(user);
    await user.type(screen.getByTestId(PALETTE_INPUT), 'lo');

    expect(within(palette).getByText('Filtered')).toBeInTheDocument();
    expect(within(palette).getByText('lo')).toBeInTheDocument();
    expect(sections).toHaveBeenCalledWith('lo');
  });

  it('runs the selected item on Enter and closes', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    await open(user);
    await user.keyboard('{Enter}');

    expect(onRun).toHaveBeenCalledWith(SCREENS.items[0]);
    await waitFor(() => {
      expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
    });
  });

  it('moves the selection down and back up with the arrow keys', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    await open(user);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');

    expect(onRun).toHaveBeenCalledWith(SCREENS.items[1]);
  });

  it('stops the selection at the last item', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    await open(user);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');

    expect(onRun).toHaveBeenCalledWith(OPS.items[0]);
  });

  it('stops the selection at the first item', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    await open(user);
    await user.keyboard('{ArrowUp}{ArrowUp}{Enter}');

    expect(onRun).toHaveBeenCalledWith(SCREENS.items[0]);
  });

  it('runs an item on click', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    const palette = await open(user);
    await user.click(within(palette).getByText('Lock account'));

    expect(onRun).toHaveBeenCalledWith(OPS.items[0]);
  });

  it('runs an item on Enter pressed on the option itself and ignores other keys', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    const palette = await open(user);
    const option = within(palette).getByText('Jobs').closest('[role="option"]')!;

    fireEvent.keyDown(option, { key: 'a' });
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.keyDown(option, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledWith(SCREENS.items[1]);
  });

  it('selects the hovered option so pointer and keyboard share one selection', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);
    const option = within(palette).getByText('Lock account').closest('[role="option"]')!;
    await user.hover(option);

    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(within(palette).getByText('Dashboard').closest('[role="option"]')).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('points the combobox at the listbox and the active option', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);
    const input = screen.getByTestId(PALETTE_INPUT);
    const listbox = within(palette).getByRole('listbox');

    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input.getAttribute('aria-controls')).toBe(listbox.getAttribute('id'));
    const active = within(palette).getByText('Dashboard').closest('[role="option"]');
    expect(input.getAttribute('aria-activedescendant')).toBe(active?.getAttribute('id'));
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    await open(user);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
    });
  });

  it('reopens with an empty query and the first item selected', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    await open(user);
    await user.type(screen.getByTestId(PALETTE_INPUT), 'jobs');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
    });

    await open(user);
    expect(screen.getByTestId(PALETTE_INPUT)).toHaveValue('');
    await user.keyboard('{Enter}');
    expect(onRun).toHaveBeenCalledWith(SCREENS.items[0]);
  });

  // A caller's own toggle, such as a Ctrl K shortcut, flips `open` shut without the
  // palette's own close running.
  describe('when the caller flips open shut', () => {
    function Controlled({
      open: isOpen,
      onRun,
    }: Readonly<{ open: boolean; onRun: (item: Item) => void }>): React.JSX.Element {
      return (
        <CommandPalette
          open={isOpen}
          onClose={vi.fn()}
          sections={() => [SCREENS, OPS]}
          onRun={onRun}
          title="Command palette"
          description="Search screens and ops. Use the arrow keys and Enter."
          placeholder="Search screens and ops"
          testId={PALETTE}
          inputTestId={PALETTE_INPUT}
          optionTestId={PALETTE_OPTION}
        />
      );
    }

    async function closeFromOutside(
      rerender: (ui: React.ReactNode) => void,
      onRun: (item: Item) => void
    ): Promise<void> {
      rerender(<Controlled open={false} onRun={onRun} />);
      await waitFor(() => {
        expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
      });
      rerender(<Controlled open onRun={onRun} />);
      await waitFor(() => {
        expect(screen.getByTestId(PALETTE)).toBeInTheDocument();
      });
    }

    it('reopens with an empty query', async () => {
      const user = userEvent.setup();
      const onRun = vi.fn();
      const { rerender } = render(<Controlled open onRun={onRun} />);
      await user.type(screen.getByTestId(PALETTE_INPUT), 'jobs');

      await closeFromOutside(rerender, onRun);

      expect(screen.getByTestId(PALETTE_INPUT)).toHaveValue('');
    });

    it('reopens with the first item selected', async () => {
      const user = userEvent.setup();
      const onRun = vi.fn();
      const { rerender } = render(<Controlled open onRun={onRun} />);
      screen.getByTestId(PALETTE_INPUT).focus();
      await user.keyboard('{ArrowDown}{ArrowDown}');

      await closeFromOutside(rerender, onRun);
      screen.getByTestId(PALETTE_INPUT).focus();
      await user.keyboard('{Enter}');

      expect(onRun).toHaveBeenCalledWith(SCREENS.items[0]);
    });
  });

  it('ignores Enter when nothing matches', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} sections={() => []} />);

    await open(user);
    await user.keyboard('{Enter}');

    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByTestId(PALETTE)).toBeInTheDocument();
  });

  it('shows the caller-supplied answer when the query leaves nothing to offer', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => []} empty={<p>nothing here</p>} />);

    await open(user);

    expect(screen.getByText('nothing here')).toBeInTheDocument();
  });

  // The placement is the whole reason the seam is a sibling of the listbox
  // rather than a child of it: inside, a screen reader announces the message as
  // one of the choices on offer. Nothing else in either package would notice
  // the move, so this is the only thing holding it.
  it('renders that answer outside the listbox, where it cannot be read as a choice', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => []} empty={<p>nothing here</p>} />);

    const palette = await open(user);

    expect(within(palette).getByText('nothing here')).toBeInTheDocument();
    expect(within(palette).getByRole('listbox')).toBeEmptyDOMElement();
  });

  // The phone form fills the screen and its listbox grows to fill it, so an answer drawn
  // after the listbox lands at the foot of the screen, far from the query it answers.
  it.each(['product', 'plain'] as const)(
    'draws that answer between the %s search field and the listbox',
    async (appearance) => {
      setWindowWidth(390);
      const user = userEvent.setup();
      render(
        <Harness
          onRun={vi.fn()}
          sections={() => []}
          empty={<p>nothing here</p>}
          appearance={appearance}
        />
      );

      const palette = await open(user);
      const answer = within(palette).getByText('nothing here');

      expect(
        screen.getByTestId(PALETTE_INPUT).compareDocumentPosition(answer) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        answer.compareDocumentPosition(within(palette).getByRole('listbox')) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
  );

  it('keeps that answer out of the way while the query still matches something', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} empty={<p>nothing here</p>} />);

    await open(user);

    expect(screen.queryByText('nothing here')).toBeNull();
  });

  it('leaves an unanswered empty result bare for a caller that offers no answer', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => []} />);

    await open(user);

    expect(within(screen.getByTestId(PALETTE)).getByRole('listbox')).toBeEmptyDOMElement();
  });

  it('tags every option with the caller-supplied test id', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);

    expect(within(palette).getAllByTestId(PALETTE_OPTION)).toHaveLength(3);
  });

  // Radix returns focus to a `DialogTrigger`; this palette is controlled and
  // opened by a shortcut, so it has none. Without a restore of its own, every
  // exit drops focus to `<body>` and the next Tab restarts at the top of the
  // document, however far down the page the reader was.
  it('returns focus to the opener when dismissed', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const opener = screen.getByRole('button', { name: 'Open' });
    await open(user);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('returns focus to the opener after an item runs', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const opener = screen.getByRole('button', { name: 'Open' });
    await open(user);
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  // The consumer shape the restore has to survive: running an item opens the
  // caller's own modal. That modal is the destination, not the opener.
  it('yields to a modal the caller opens when an item runs', async () => {
    const user = userEvent.setup();

    function Consumer(): React.JSX.Element {
      const [asking, setAsking] = React.useState(false);
      return (
        <>
          <Harness
            onRun={() => {
              setAsking(true);
            }}
          />
          <Dialog
            open={asking}
            onOpenChange={() => {
              setAsking(false);
            }}
          >
            <DialogContent showCloseButton={false}>
              <DialogTitle>Lock account</DialogTitle>
              <DialogDescription>Confirm before the account is locked.</DialogDescription>
              <button type="button">Confirm</button>
            </DialogContent>
          </Dialog>
        </>
      );
    }

    render(<Consumer />);
    await open(user);
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    });
  });

  it("moves focus to the page's main landmark when the opener is gone", async () => {
    const user = userEvent.setup();
    render(
      <main aria-label="Page">
        <Harness onRun={vi.fn()} openerSurvives={false} />
      </main>
    );

    await open(user);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('main', { name: 'Page' })).toHaveFocus();
    });
  });
});

describe('CommandPalette in the product appearance', () => {
  function optionFor(palette: HTMLElement, label: string): HTMLElement {
    const option = within(palette).getByText(label).closest<HTMLElement>('[role="option"]');
    if (option === null) throw new Error(`no option holds ${label}`);
    return option;
  }

  it('heads each section in red serif over a hairline', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => [GO_TO]} />);

    const palette = await open(user);
    const head = within(palette).getByRole('heading', { name: 'Go to' });

    expect(head.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['font-serif', 'font-bold', 'text-brand-red', 'after:border-t'])
    );
  });

  it('draws an item icon in a tile before its label', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => [GO_TO]} />);

    const palette = await open(user);
    const option = optionFor(palette, 'Settings');

    expect(option.firstElementChild?.querySelector('svg')).not.toBeNull();
  });

  it('shows an item meta at the end of its row', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => [GO_TO]} />);

    const palette = await open(user);

    expect(within(optionFor(palette, 'Settings')).getByText('Today')).toBeInTheDocument();
  });

  it('tints the highlighted row red and turns its tile white on red', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => [GO_TO]} />);

    const palette = await open(user);
    const selected = optionFor(palette, 'Settings');
    const other = optionFor(palette, 'Search');

    expect(selected).toHaveClass('bg-brand-red-subtle');
    expect(selected.firstElementChild).toHaveClass('bg-brand-red', 'text-primary-foreground');
    expect(other).not.toHaveClass('bg-brand-red-subtle');
    expect(other.firstElementChild).not.toHaveClass('bg-brand-red');
  });

  it('offers the Enter hint on the highlighted row only', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => [GO_TO]} />);

    const palette = await open(user);

    expect(within(optionFor(palette, 'Settings')).getByText('Enter')).toBeInTheDocument();
    expect(within(optionFor(palette, 'Search')).queryByText('Enter')).toBeNull();
  });

  it('names the search field with a floating label', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    await open(user);
    const input = screen.getByTestId<HTMLInputElement>(PALETTE_INPUT);

    expect(input.labels?.[0]).toHaveTextContent('Search screens and ops');
  });

  it('shows the Esc hint in the search field', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);
    const field = screen.getByTestId(PALETTE_INPUT).parentElement;

    expect(within(field!).getByText('Esc').tagName).toBe('KBD');
    expect(palette).toContainElement(field);
  });

  it('closes from the X beside the search field', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);
    await user.click(within(palette).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
    });
  });

  it('shows the X only where the key hints are hidden', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);
    const close = within(palette).getByRole('button', { name: 'Close' });

    expect(close).toHaveClass('hidden', 'max-md:inline-flex', 'pointer-coarse:inline-flex');
  });

  it('draws the key legend and the wordmark in the footer', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);
    const footer = within(palette).getByText('Move').closest('footer');

    expect(footer).toHaveTextContent(/Move.*Open.*Close.*HushBox/);
  });

  it('drops the footer where the key hints are hidden', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);
    const footer = within(palette).getByText('Move').closest('footer');

    expect(footer).toHaveClass('max-md:hidden', 'pointer-coarse:hidden');
  });

  it('draws the footer the caller passes in place of its own', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} footer={<span>caller footer</span>} />);

    const palette = await open(user);

    expect(within(palette).getByText('caller footer').closest('footer')).not.toBeNull();
    expect(within(palette).queryByText('Move')).toBeNull();
  });

  it('opens near the top of the viewport from 768', async () => {
    setWindowWidth(1440);
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    await open(user);

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveClass('top-[calc(12vh-0.5rem)]');
  });

  // At large text the field, heads and footer outgrow the top placement; capped, the panel
  // shrinks its list and keeps the footer in view instead of scrolling the whole dialog.
  it('fits the panel under its top placement so only the list scrolls', async () => {
    setWindowWidth(1440);
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);

    expect(palette).toHaveClass('max-h-[calc(88dvh-1.5rem)]');
    expect(within(palette).getByRole('listbox')).toHaveClass('min-h-0', 'flex-1');
  });

  it('fills the screen below 768', async () => {
    setWindowWidth(767);
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    const palette = await open(user);

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveClass('inset-0', 'h-dvh');
    expect(palette).toHaveClass('h-full', 'rounded-none');
  });

  it('describes how to use the palette to the search field', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} />);

    await open(user);

    expect(screen.getByTestId(PALETTE_INPUT)).toHaveAccessibleDescription(
      'Search screens and ops. Use the arrow keys and Enter.'
    );
  });
});

describe('CommandPalette in the plain appearance', () => {
  it('heads each section in small muted capitals', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    const palette = await open(user);
    const head = within(palette).getByRole('heading', { name: 'Screens' });

    expect(head).toHaveClass('text-muted-foreground', 'text-xs', 'uppercase');
    expect(head).not.toHaveClass('font-serif');
  });

  it('names its search field without a floating label', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    await open(user);
    const input = screen.getByTestId<HTMLInputElement>(PALETTE_INPUT);

    expect(input).toHaveAccessibleName('Search screens and ops');
    expect(input.labels).toHaveLength(0);
  });

  it('draws its rows without icon tiles or an Enter hint', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} sections={() => [GO_TO]} appearance="plain" />);

    const palette = await open(user);
    const selected = within(palette).getByText('Settings').closest('[role="option"]');

    expect(selected?.querySelector('svg')).toBeNull();
    expect(selected).toHaveClass('bg-accent');
    expect(selected).toHaveTextContent(/^Settings$/);
  });

  it('draws no X, no Esc hint and no footer', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    const palette = await open(user);

    expect(within(palette).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(palette).queryByText('Esc')).toBeNull();
    expect(palette.querySelector('footer')).toBeNull();
  });

  it('sits 6rem from the top of the viewport', async () => {
    setWindowWidth(1440);
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    const palette = await open(user);

    expect(palette).toHaveClass('top-24', 'translate-y-0');
  });

  it('draws its scrim without a blur', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    await open(user);
    const scrim = document.querySelector('[data-slot="dialog-overlay"]');

    expect(scrim).not.toBeNull();
    expect(scrim).not.toHaveClass('backdrop-blur-sm');
  });

  it('stays a floating dialog below 768', async () => {
    setWindowWidth(390);
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    const palette = await open(user);

    expect(palette).toHaveClass('top-24', 'max-w-[calc(100%-2rem)]');
    expect(palette).not.toHaveClass('h-full');
    expect(screen.queryByTestId(TEST_IDS.overlayContent)).toBeNull();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    const opener = screen.getByRole('button', { name: 'Open' });
    await open(user);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId(PALETTE)).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('focuses its search field on open under a coarse pointer', async () => {
    setWindowWidth(1440, 'coarse');
    const user = userEvent.setup();
    render(<Harness onRun={vi.fn()} appearance="plain" />);

    await open(user);

    expect(screen.getByTestId(PALETTE_INPUT)).toHaveFocus();
  });
});

describe('buildSections', () => {
  const groups = [SCREENS, OPS];

  it('lists the groups untouched for an empty query', () => {
    expect(buildSections({ query: '', groups })).toEqual(groups);
  });

  it('puts recents first when there are any', () => {
    const recents = [{ id: 'jobs', label: 'Jobs', target: '/jobs' }];

    expect(buildSections({ query: '  ', groups, recents })).toEqual([
      { heading: 'Recents', items: recents },
      ...groups,
    ]);
  });

  it('omits the recents section when there are none', () => {
    expect(buildSections({ query: '', groups, recents: [] })).toEqual(groups);
  });

  it('promotes the first match to a top-result section and drops it from its group', () => {
    const result = buildSections({ query: 'jobs', groups });

    expect(result[0]).toEqual({ heading: 'Top result', items: [SCREENS.items[1]] });
    expect(result.map((section) => section.heading)).toEqual(['Top result']);
  });

  it('keeps the remaining matches of a group under their own heading', () => {
    const result = buildSections({
      query: 'o',
      groups: [{ heading: 'Screens', items: SCREENS.items }],
    });

    expect(result).toEqual([
      { heading: 'Top result', items: [SCREENS.items[0]] },
      { heading: 'Screens', items: [SCREENS.items[1]] },
    ]);
  });

  it('trims and lowercases the query before matching', () => {
    const result = buildSections({ query: '  JOBS ', groups });

    expect(result[0]).toEqual({ heading: 'Top result', items: [SCREENS.items[1]] });
  });

  it('matches an item on its hint as well as its label', () => {
    const result = buildSections({ query: 'user.lock', groups });

    expect(result[0]).toEqual({ heading: 'Top result', items: [OPS.items[0]] });
  });

  it('appends the caller fallback section for a non-empty query', () => {
    const fallback = vi.fn((query: string) => ({
      heading: 'Users',
      items: [{ id: `user:${query}`, label: `Go to user "${query}"`, target: query }],
    }));

    const result = buildSections({ query: ' Nobody ', groups, fallback });

    expect(fallback).toHaveBeenCalledWith('nobody');
    expect(result).toEqual([
      {
        heading: 'Users',
        items: [{ id: 'user:nobody', label: 'Go to user "nobody"', target: 'nobody' }],
      },
    ]);
  });

  it('returns nothing when nothing matches and there is no fallback', () => {
    expect(buildSections({ query: 'nobody', groups })).toEqual([]);
  });

  it('leaves the fallback out of an empty query', () => {
    const fallback = vi.fn(() => ({ heading: 'Users', items: [] }));

    buildSections({ query: '', groups, fallback });

    expect(fallback).not.toHaveBeenCalled();
  });
});
