import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { TEST_IDS } from '@/test-ids';
import { useConsoleHotkeys } from '@/components/shell/hooks/use-console-hotkeys';
import { ConfirmDialog } from './confirm-dialog';
import type { ComponentProps, JSX } from 'react';

function renderDialog(overrides: Partial<ComponentProps<typeof ConfirmDialog>> = {}): {
  confirm: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn();
  const close = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Reopen AC-1?"
      confirmLabel="Reopen"
      onConfirm={confirm}
      onClose={close}
      {...overrides}
    >
      <p>Two notes were recorded against this finding.</p>
    </ConfirmDialog>
  );
  return { confirm, close };
}

/** Elements whose content model is phrasing only, so none of them can hold a paragraph. */
const PHRASING_ONLY = new Set(['P', 'SPAN', 'LABEL', 'EM', 'STRONG', 'B', 'I', 'SMALL', 'CODE']);

/**
 * The opener shapes the callers actually produce, named for what happens to the
 * control the reader pressed. Only the first leaves it usable; the rest take it
 * away at a different moment, or leave it in place unable to hold focus, and
 * each breaks focus return its own way.
 */
type OpenerShape =
  /** An option button on the finding card: the card re-renders around it. */
  | 'survives'
  /** A bulk action: confirming empties the section the button was in. */
  | 'removed-by-the-action'
  /** Reopen: the write is async, so the row goes a moment after the close. */
  | 'removed-after-the-action'
  /** Deny and the note form: the caller unmounts the opener in the same click. */
  | 'unmounted-on-open'
  /** Approve recommended: the button stays, with nothing left to act on. */
  | 'disabled-by-the-action';

/**
 * Mirrors how every caller uses it: a control the reader activates, and the
 * dialog mounted only while it is being asked. Focus restoration is meaningless
 * without a real opener to restore to.
 */
function renderFromOpener(shape: OpenerShape = 'survives'): {
  opener: HTMLElement;
  region: HTMLElement;
} {
  function Harness(): JSX.Element {
    const [asking, setAsking] = useState(false);
    const [gone, setGone] = useState(false);
    const [spent, setSpent] = useState(false);

    function act(): void {
      setAsking(false);
      if (shape === 'removed-by-the-action') setGone(true);
      if (shape === 'disabled-by-the-action') setSpent(true);
      if (shape === 'removed-after-the-action') {
        // Radix restores focus from its own `setTimeout(…, 0)`, so a zero delay
        // here would remove the opener before the restore ever reached it and
        // the test would pass without exercising the case it names.
        setTimeout(() => {
          setGone(true);
        }, 20);
      }
    }

    return (
      <section aria-label="Bulk actions">
        {!gone && (
          <button
            type="button"
            disabled={spent}
            onClick={() => {
              setAsking(true);
              if (shape === 'unmounted-on-open') setGone(true);
            }}
          >
            Deny all 11
          </button>
        )}
        {asking && (
          <ConfirmDialog
            open
            title="Deny all 11?"
            confirmLabel="Deny them"
            onConfirm={act}
            onClose={() => {
              setAsking(false);
            }}
          >
            <p>This writes to every one of them.</p>
          </ConfirmDialog>
        )}
      </section>
    );
  }

  render(<Harness />);
  const region = screen.getByRole('region', { name: 'Bulk actions' });
  const opener = screen.getByRole('button', { name: 'Deny all 11' });
  opener.focus();
  fireEvent.click(opener);
  return { opener, region };
}

/**
 * A keystroke as the reader produces one: it starts at whatever holds focus and
 * travels up through the document to the window, so it passes both the dialog's
 * own dismissal listener and the console's window-level shortcuts.
 */
function press(key: string): void {
  fireEvent.keyDown(document.body, { key, bubbles: true });
}

/**
 * The console with its shortcuts live and a dialog over it, which is the only
 * arrangement in which the shortcuts can reach past a dialog at all.
 */
function renderOverConsole(): {
  move: ReturnType<typeof vi.fn>;
  escape: ReturnType<typeof vi.fn>;
  show: (dialogs: number) => void;
  close: () => void;
} {
  const move = vi.fn<(direction: 1 | -1) => void>();
  const escape = vi.fn<() => void>();

  function Harness({ dialogs }: { readonly dialogs: number }): JSX.Element {
    const [open, setOpen] = useState(true);
    useConsoleHotkeys({
      onSearch: () => {},
      onPalette: () => {},
      onShortcuts: () => {},
      onMove: move,
    });

    return (
      <>
        {Array.from({ length: dialogs }, (_, index) => (
          <ConfirmDialog
            key={index}
            open={open}
            title={`Deny all ${String(index)}?`}
            confirmLabel="Deny them"
            onConfirm={() => {}}
            onClose={() => {
              setOpen(false);
              escape();
            }}
          >
            <p>This writes to every one of them.</p>
          </ConfirmDialog>
        ))}
      </>
    );
  }

  const { rerender } = render(<Harness dialogs={1} />);
  return {
    move,
    escape,
    show: (dialogs) => {
      rerender(<Harness dialogs={dialogs} />);
    },
    close: () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);
    },
  };
}

describe('ConfirmDialog', () => {
  it('names what is about to happen', () => {
    renderDialog();

    expect(screen.getByRole('heading', { name: 'Reopen AC-1?' })).toBeInTheDocument();
  });

  it('shows the detail the reader has to weigh', () => {
    renderDialog();

    expect(screen.getByText('Two notes were recorded against this finding.')).toBeInTheDocument();
  });

  it('runs the action when the reader confirms', () => {
    const { confirm } = renderDialog();

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('backs out without running the action', () => {
    const { confirm, close } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while it is closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('heading', { name: 'Reopen AC-1?' })).not.toBeInTheDocument();
  });

  it('closes when the dialog itself is dismissed', () => {
    const { close } = renderDialog();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(close).toHaveBeenCalled();
  });

  it('holds the confirm button while the action is running', () => {
    renderDialog({ busy: true });

    expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeDisabled();
  });

  it('carries the guard copy as its accessible description', () => {
    renderDialog();

    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Two notes were recorded against this finding.'
    );
  });

  it('resolves the description it advertises to a real element', () => {
    renderDialog();

    const describedBy = screen.getByRole('dialog').getAttribute('aria-describedby');

    expect(describedBy).toEqual(expect.any(String));
    expect(document.querySelector(`#${String(describedBy)}`)).toHaveTextContent(
      'Two notes were recorded against this finding.'
    );
  });

  it("sets the guard copy's paragraphs in block containers only", () => {
    renderDialog();

    const describedBy = screen.getByRole('dialog').getAttribute('aria-describedby');
    const description = document.querySelector(`#${String(describedBy)}`);
    const paragraph = screen.getByText('Two notes were recorded against this finding.');
    const wrappers: string[] = [];
    let node = paragraph.parentElement;
    while (node !== null && node !== description) {
      wrappers.push(node.tagName);
      node = node.parentElement;
    }

    expect(node).toBe(description);
    expect(wrappers.filter((tag) => PHRASING_ONLY.has(tag))).toEqual([]);
  });

  it('does not warn that its description is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderDialog();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns focus to the control that opened it when the reader backs out', async () => {
    const { opener } = renderFromOpener();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('returns focus to the control that opened it after the action runs', async () => {
    const { opener } = renderFromOpener();

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('ignores page churn that leaves the landing alone', async () => {
    const { opener } = renderFromOpener();

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });

    const stray = document.createElement('div');
    document.body.append(stray);
    await waitFor(() => {
      expect(stray.isConnected).toBe(true);
    });
    stray.remove();
    await waitFor(() => {
      expect(stray.isConnected).toBe(false);
    });

    expect(document.activeElement).toBe(opener);
  });

  it('lands focus where the opener stood when the action removes it', async () => {
    const { region } = renderFromOpener('removed-by-the-action');

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(document.activeElement).toBe(region);
    });
  });

  it('follows the action when it removes the restored control a moment later', async () => {
    const { region } = renderFromOpener('removed-after-the-action');

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(document.activeElement).toBe(region);
    });
  });

  it('lands on the region when the caller unmounts the opener as it opens', async () => {
    const { region } = renderFromOpener('unmounted-on-open');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(document.activeElement).toBe(region);
    });
  });

  it('never leaves focus on the document body', async () => {
    const { region } = renderFromOpener('unmounted-on-open');

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(document.activeElement).toBe(region);
    });
    expect(document.body).not.toHaveAttribute('tabindex');
  });

  it('steps past the opener when the action disables it', async () => {
    const { opener, region } = renderFromOpener('disabled-by-the-action');

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(() => {
      expect(document.activeElement).toBe(region);
    });
    expect(opener).not.toHaveAttribute('tabindex');
  });

  it('suspends the console shortcuts while it is open', () => {
    const { move } = renderOverConsole();

    press('j');

    expect(move).not.toHaveBeenCalled();
  });

  it('gives the shortcuts back once it closes', async () => {
    const { move, close } = renderOverConsole();

    close();
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.confirmAccept)).toBeNull();
    });
    press('j');

    expect(move).toHaveBeenCalledWith(1);
  });

  it('gives the shortcuts back when it is unmounted without closing', async () => {
    const { move, show } = renderOverConsole();

    show(0);
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.confirmAccept)).toBeNull();
    });
    press('j');

    expect(move).toHaveBeenCalledWith(1);
  });

  it('keeps the shortcuts suspended while a second dialog over it closes', async () => {
    const { move, show } = renderOverConsole();

    show(2);
    show(1);
    await waitFor(() => {
      expect(screen.getAllByTestId(TEST_IDS.confirmAccept)).toHaveLength(1);
    });
    press('j');

    expect(move).not.toHaveBeenCalled();
  });

  it('is still dismissed by the Escape it suspends', async () => {
    const { escape } = renderOverConsole();

    press('Escape');

    await waitFor(() => {
      expect(escape).toHaveBeenCalledTimes(1);
    });
  });

  it('does not pass the keystroke that dismissed it to the console', async () => {
    const { move, escape } = renderOverConsole();

    press('Escape');
    await waitFor(() => {
      expect(escape).toHaveBeenCalled();
    });

    expect(move).not.toHaveBeenCalled();
  });

  it('leaves focus alone once the reader has moved it somewhere else', async () => {
    const { region } = renderFromOpener('removed-after-the-action');
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });
    elsewhere.focus();
    await waitFor(() => {
      expect(region.isConnected).toBe(true);
    });

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
