import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { formatHotkey } from '@hushbox/ui';
import { useFindingHotkeys } from '@/components/finding/hooks/use-finding-hotkeys';
import { useConsoleHotkeys } from '@/components/shell/hooks/use-console-hotkeys';
import { usePublishBindings } from './published-bindings';
import { ShortcutLegend } from './shortcut-legend';
import type { HotkeyBinding } from '@hushbox/ui';
import type { JSX } from 'react';

const SHELL_BINDINGS: readonly HotkeyBinding[] = [
  { combo: '/', description: 'Search' },
  { combo: 'shift+?', description: 'Keyboard shortcuts' },
];

function renderLegend(
  bindings: readonly HotkeyBinding[] = SHELL_BINDINGS,
  open = true
): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn<() => void>();
  render(<ShortcutLegend open={open} onClose={onClose} bindings={bindings} />);
  return { onClose };
}

function legend(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
}

/** What the reader sees on the keys, in the order the legend lists them. */
function keysOnScreen(): string[] {
  return [...legend().querySelectorAll('kbd')].map((key) => key.textContent);
}

function press(key: string, init: KeyboardEventInit = {}): void {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

/**
 * A surface that claims Escape and names it after itself, as any dismissable
 * layer might. It stands in for the card, which is the one surface that
 * publishes, so it is never rendered beside a real one.
 */
function EscapeClaimant(): JSX.Element {
  usePublishBindings('card', [{ combo: 'escape', description: 'Close the source preview' }]);
  return <p>a layer</p>;
}

/**
 * The legend as the console raises it: from a control the reader activated,
 * which is the only arrangement in which focus has somewhere to go back to.
 */
function openFromAControl(): HTMLElement {
  function Harness(): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Keyboard shortcuts
        </button>
        <ShortcutLegend
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          bindings={SHELL_BINDINGS}
        />
      </>
    );
  }

  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Keyboard shortcuts' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

/** A card on screen, which is the only thing that binds the ruling keys. */
function Card({
  optionIds,
  undoable = false,
}: Readonly<{ optionIds: readonly string[]; undoable?: boolean }>): JSX.Element {
  useFindingHotkeys({
    optionIds,
    recommendedId: null,
    editing: false,
    active: true,
    onChooseOption: vi.fn(),
    onNote: vi.fn(),
    onRule: vi.fn(),
    onDeny: vi.fn(),
    onAsk: vi.fn(),
    onUndo: undoable ? vi.fn() : null,
    onEscape: vi.fn(),
  });
  return <p>a finding</p>;
}

describe('ShortcutLegend', () => {
  it('stays out of the way until it is asked for', () => {
    renderLegend(SHELL_BINDINGS, false);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows every key it was given, after which it names the one it answers itself', () => {
    renderLegend();

    expect(keysOnScreen()).toEqual([
      formatHotkey('/', { apple: false }),
      formatHotkey('shift+?', { apple: false }),
      formatHotkey('escape', { apple: false }),
    ]);
  });

  it('shows its keys at every width and pointer, since the keys are what it lists', () => {
    renderLegend();

    const keys = [...legend().querySelectorAll('[data-slot="kbd"]')];
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).not.toHaveClass('max-md:hidden');
      expect(key).not.toHaveClass('pointer-coarse:hidden');
    }
  });

  it('says what each key does', () => {
    renderLegend();

    expect(within(legend()).getByText('Search')).toBeInTheDocument();
  });

  it('drops a key the console is not listening for here', () => {
    renderLegend([{ combo: '/', description: 'Search' }]);

    expect(keysOnScreen()).toEqual([
      formatHotkey('/', { apple: false }),
      formatHotkey('escape', { apple: false }),
    ]);
  });

  it('shows the ruling keys of the card on screen', () => {
    render(
      <>
        <Card optionIds={['A', 'B']} />
        <ShortcutLegend open onClose={vi.fn()} bindings={SHELL_BINDINGS} />
      </>
    );

    expect(within(legend()).getByText('Rule with option B')).toBeInTheDocument();
  });

  it('offers no ruling keys with no card on screen', () => {
    renderLegend();

    expect(within(legend()).queryByText('Deny')).toBeNull();
  });

  it('takes the console keyboard for as long as it is open', () => {
    const onMove = vi.fn<(direction: 1 | -1) => void>();
    function Harness(): JSX.Element {
      const bindings = useConsoleHotkeys({
        onSearch: vi.fn(),
        onPalette: vi.fn(),
        onShortcuts: vi.fn(),
        onMove,
      });
      return <ShortcutLegend open onClose={vi.fn()} bindings={bindings} />;
    }
    render(<Harness />);

    press('j');

    expect(onMove).not.toHaveBeenCalled();
  });

  it('lists the keys it is holding, rather than emptying itself as it opens', () => {
    function Harness(): JSX.Element {
      const bindings = useConsoleHotkeys({
        onSearch: vi.fn(),
        onPalette: vi.fn(),
        onShortcuts: vi.fn(),
        onMove: vi.fn(),
      });
      return <ShortcutLegend open onClose={vi.fn()} bindings={bindings} />;
    }
    render(<Harness />);

    expect(within(legend()).getByText('Next finding')).toBeInTheDocument();
  });

  it('offers no undo while the card has nothing to take back', () => {
    render(
      <>
        <Card optionIds={[]} />
        <ShortcutLegend open onClose={vi.fn()} bindings={SHELL_BINDINGS} />
      </>
    );

    expect(within(legend()).queryByText('Undo the last write')).toBeNull();
  });

  it('offers undo once the card has a write to take back', () => {
    render(
      <>
        <Card optionIds={[]} undoable />
        <ShortcutLegend open onClose={vi.fn()} bindings={SHELL_BINDINGS} />
      </>
    );

    expect(within(legend()).getByText('Undo the last write')).toBeInTheDocument();
  });

  it('offers the key that dismisses it in every view, including one with nothing to preview', () => {
    renderLegend();

    expect(within(legend()).getByText('Close what is open')).toBeInTheDocument();
  });

  it('offers a key once when two layers bind it at the same time', () => {
    render(
      <>
        <Card optionIds={[]} />
        <ShortcutLegend open onClose={vi.fn()} bindings={SHELL_BINDINGS} />
      </>
    );

    const escapes = keysOnScreen().filter(
      (key) => key === formatHotkey('escape', { apple: false })
    );
    expect(escapes).toHaveLength(1);
  });

  it('describes a shared key by what it does to everything it reaches', () => {
    render(
      <>
        <EscapeClaimant />
        <ShortcutLegend open onClose={vi.fn()} bindings={SHELL_BINDINGS} />
      </>
    );

    expect(within(legend()).getByText('Close what is open')).toBeInTheDocument();
    expect(within(legend()).queryByText('Close the source preview')).toBeNull();
  });

  it('returns focus to the control that opened it', async () => {
    const opener = openFromAControl();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('returns focus to the control that opened it when the reader uses the close button', async () => {
    const opener = openFromAControl();

    fireEvent.click(within(legend()).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('gives the keyboard back when the reader dismisses it', () => {
    const { onClose } = renderLegend();

    fireEvent.keyDown(legend(), { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
