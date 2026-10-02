import * as React from 'react';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { OverlayDialog as PublishedOverlayDialog } from '@hushbox/ui';
import { TouchDeviceOverrideContext } from '../../hooks/touch-device-override-context';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { OverlayDialog } from './overlay-dialog';
import { Overlay } from './overlay';
import { OverlayHeader } from './overlay-header';
import { PortalContainerProvider } from '../primitives/portal-container';

/** Skips open autofocus as the narrow-viewport modals do, to keep a soft keyboard down. */
function skipAutoFocus(event: Event): void {
  event.preventDefault();
}

/** A page control after the opener, which Tab reaches if focus leaves the open dialog. */
function DialogFromPage(): React.JSX.Element {
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
      <button type="button">Page action</button>
      <OverlayDialog
        returnFocus={vi.fn()}
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Test overlay"
        onOpenAutoFocus={skipAutoFocus}
      >
        <input aria-label="Code" />
        <button type="button">Verify</button>
      </OverlayDialog>
    </>
  );
}

/** A menu whose Rename item opens a dialog holding a name field, as a chat row's menu does. */
function DialogFromMenu(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);
  return (
    <TouchDeviceOverrideContext value={false}>
      <DropdownMenu>
        <DropdownMenuTrigger>More options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onSelect={() => {
              setOpen(true);
            }}
          >
            Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Overlay open={open} onOpenChange={setOpen} ariaLabel="Rename" initialFocus={nameRef}>
        <input ref={nameRef} aria-label="Name" />
      </Overlay>
    </TouchDeviceOverrideContext>
  );
}

describe('OverlayDialog', () => {
  it('focuses the field it names when a menu item opens it', async () => {
    const user = userEvent.setup();
    render(<DialogFromMenu />);

    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    });
  });

  it('focuses the dialog itself, not the field it names, when the consumer skips open autofocus', async () => {
    function NamedFieldSkipped(): React.JSX.Element {
      const nameRef = React.useRef<HTMLInputElement>(null);
      return (
        <OverlayDialog
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={() => {}}
          ariaLabel="Test overlay"
          onOpenAutoFocus={skipAutoFocus}
          initialFocus={nameRef}
        >
          <input ref={nameRef} aria-label="Name" />
        </OverlayDialog>
      );
    }
    render(<NamedFieldSkipped />);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveFocus();
    });
  });

  it('caps its own height and scrolls internally so actions stay reachable', () => {
    render(
      <OverlayDialog
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={() => {}}
        ariaLabel="Test overlay"
      >
        <p>Child</p>
      </OverlayDialog>
    );

    const content = screen.getByTestId(TEST_IDS.overlayContent);
    expect(content).toHaveClass('max-h-[calc(100dvh-2rem)]');
    expect(content).toHaveClass('overflow-y-auto');
  });

  it('moves focus to the dialog itself when the consumer skips open autofocus', async () => {
    const user = userEvent.setup();
    render(<DialogFromPage />);

    await user.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveFocus();
    });
  });

  it('keeps Tab inside the dialog when the consumer skips open autofocus', async () => {
    const user = userEvent.setup();
    render(<DialogFromPage />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');

    for (let press = 0; press < 5; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('moves Shift+Tab from the dialog itself to the last control in the dialog', async () => {
    const user = userEvent.setup();
    render(<DialogFromPage />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog).toHaveFocus();
    });

    await user.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Verify' })).toHaveFocus();
  });

  it('leaves open autofocus on the first control when the consumer does not skip it', async () => {
    render(
      <OverlayDialog
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={() => {}}
        ariaLabel="Test overlay"
      >
        <button type="button">Verify</button>
      </OverlayDialog>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });
  });

  it('reveals the first control when Tab wraps from the last control', async () => {
    const user = userEvent.setup();
    render(
      <OverlayDialog
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={() => {}}
        ariaLabel="Test overlay"
        showCloseButton={false}
      >
        <button type="button">First</button>
        <button type="button">Middle</button>
        <button type="button">Last</button>
      </OverlayDialog>
    );
    const first = screen.getByRole('button', { name: 'First' });
    await waitFor(() => {
      expect(first).toHaveFocus();
    });
    screen.getByRole('button', { name: 'Last' }).focus();
    const scrollIntoView = vi.spyOn(first, 'scrollIntoView');

    await user.tab();

    expect(first).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('reveals the last control when Shift+Tab wraps from the first control', async () => {
    const user = userEvent.setup();
    render(
      <OverlayDialog
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={() => {}}
        ariaLabel="Test overlay"
        showCloseButton={false}
      >
        <button type="button">First</button>
        <button type="button">Middle</button>
        <button type="button">Last</button>
      </OverlayDialog>
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    });
    const last = screen.getByRole('button', { name: 'Last' });
    const scrollIntoView = vi.spyOn(last, 'scrollIntoView');

    await user.tab({ shift: true });

    expect(last).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('never focuses the dialog itself on the way when Radix autofocuses the first control', async () => {
    const focused: EventTarget[] = [];
    const record = (event: FocusEvent): void => {
      if (event.target !== null) focused.push(event.target);
    };
    document.addEventListener('focusin', record);
    try {
      render(
        <OverlayDialog
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={() => {}}
          ariaLabel="Test overlay"
        >
          <button type="button">Verify</button>
        </OverlayDialog>
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
      });

      expect(focused).not.toContain(screen.getByRole('dialog'));
    } finally {
      document.removeEventListener('focusin', record);
    }
  });

  describe('accessible description', () => {
    it.each([
      ['centred', false],
      ['full-screen', true],
    ])('names the header description as the %s dialog description', async (_label, fullscreen) => {
      render(
        <OverlayDialog
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={() => {}}
          ariaLabel="Change password"
          fullscreen={fullscreen}
        >
          <OverlayHeader title="Change password" description="Other devices sign out." />
        </OverlayDialog>
      );

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Other devices sign out.');
      });
    });

    it('has no accessible description when the header has none', async () => {
      render(
        <OverlayDialog returnFocus={vi.fn()} open={true} onOpenChange={() => {}} ariaLabel="Invite">
          <OverlayHeader title="Invite" />
        </OverlayDialog>
      );

      const dialog = await screen.findByRole('dialog');

      expect(dialog).not.toHaveAttribute('aria-describedby');
    });

    it('drops the description when the header that drew it unmounts', async () => {
      const { rerender } = render(
        <OverlayDialog returnFocus={vi.fn()} open={true} onOpenChange={() => {}} ariaLabel="Invite">
          <OverlayHeader title="Invite" description="Send a link." />
        </OverlayDialog>
      );
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect(dialog).toHaveAccessibleDescription('Send a link.');
      });

      rerender(
        <OverlayDialog returnFocus={vi.fn()} open={true} onOpenChange={() => {}} ariaLabel="Invite">
          <OverlayHeader title="Invite" />
        </OverlayDialog>
      );

      await waitFor(() => {
        expect(dialog).not.toHaveAttribute('aria-describedby');
      });
    });

    it.each([
      ['with', 'Send a link.'],
      ['without', undefined],
    ])('raises no missing-description warning %s a description', async (_label, description) => {
      const warn = vi.spyOn(console, 'warn');
      const error = vi.spyOn(console, 'error');
      try {
        render(
          <OverlayDialog
            returnFocus={vi.fn()}
            open={true}
            onOpenChange={() => {}}
            ariaLabel="Invite"
          >
            <OverlayHeader title="Invite" description={description} />
          </OverlayDialog>
        );
        await screen.findByRole('dialog');

        await waitFor(() => {
          const printed = [...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0]));
          expect(printed.filter((line) => line.includes('Description'))).toEqual([]);
        });
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
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

describe('OverlayDialog portal', () => {
  it('portals the dialog to the document body when given no container', () => {
    const { container } = render(
      <OverlayDialog returnFocus={vi.fn()} open onOpenChange={vi.fn()} ariaLabel="Test overlay">
        <p>Body</p>
      </OverlayDialog>
    );

    const dialog = screen.getByTestId(TEST_IDS.overlayContent);
    expect(container).not.toContainElement(dialog);
    expect(dialog.parentElement).toBe(document.body);
  });

  it('portals the dialog into the container it is given', () => {
    const target = portalTarget();
    render(
      <OverlayDialog
        returnFocus={vi.fn()}
        open
        onOpenChange={vi.fn()}
        ariaLabel="Test overlay"
        container={target}
      >
        <p>Body</p>
      </OverlayDialog>
    );

    expect(target).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });

  it('portals the dialog into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <OverlayDialog returnFocus={vi.fn()} open onOpenChange={vi.fn()} ariaLabel="Test overlay">
          <p>Body</p>
        </OverlayDialog>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });

  it('portals the dialog into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <OverlayDialog
          returnFocus={vi.fn()}
          open
          onOpenChange={vi.fn()}
          ariaLabel="Test overlay"
          container={own}
        >
          <p>Body</p>
        </OverlayDialog>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
    expect(provided).not.toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });

  it('is published from the package entry', () => {
    expect(PublishedOverlayDialog).toBe(OverlayDialog);
  });
});
