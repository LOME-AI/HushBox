import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { OverlayBottomSheet as PublishedOverlayBottomSheet } from '@hushbox/ui';
import { OverlayBottomSheet } from './overlay-bottom-sheet';
import { OverlayHeader } from './overlay-header';
import { PortalContainerProvider } from '../primitives/portal-container';

/** A page control after the opener, which Tab reaches if focus leaves the open sheet. */
function SheetFromPage(): React.JSX.Element {
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
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Test sheet"
      >
        <input aria-label="Name" />
        <button type="button">Save</button>
      </OverlayBottomSheet>
    </>
  );
}

/** Opens a sheet holding only `children`, and resolves once the sheet holds focus. */
async function openSheetHolding(children: React.ReactNode): Promise<HTMLElement> {
  render(
    <OverlayBottomSheet
      returnFocus={vi.fn()}
      open={true}
      onOpenChange={vi.fn()}
      ariaLabel="Test sheet"
      showCloseButton={false}
    >
      {children}
    </OverlayBottomSheet>
  );
  const sheet = await screen.findByRole('dialog');
  await waitFor(() => {
    expect(sheet).toHaveFocus();
  });
  return sheet;
}

describe('OverlayBottomSheet', () => {
  it('renders children when open', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.getByText('Sheet content')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={false}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.queryByText('Sheet content')).not.toBeInTheDocument();
  });

  it('renders drag handle indicator', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    const content = screen.getByTestId(TEST_IDS.overlayContent);
    const handle = content.querySelector('.rounded-full');
    expect(handle).toBeInTheDocument();
  });

  it('renders a visually hidden title when no heading is rendered', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="My sheet title"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    const title = screen.getByText('My sheet title');
    expect(title).toBeInTheDocument();
    expect(title).toHaveClass('sr-only');
  });

  it('renders close button by default', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('hides close button when showCloseButton is false', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        showCloseButton={false}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  describe('dismissible=false', () => {
    it('hides the close button so the user has no manual escape hatch', () => {
      render(
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test sheet"
          dismissible={false}
        >
          <div>Sheet content</div>
        </OverlayBottomSheet>
      );
      expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    });

    it('does not render the drag handle when undismissible (drag is the dismissal affordance)', () => {
      render(
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test sheet"
          dismissible={false}
        >
          <div>Sheet content</div>
        </OverlayBottomSheet>
      );
      // Drag handle is the small pill above the content. When swipe-to-dismiss
      // is disabled the handle becomes a lie — hide it.
      const content = screen.getByTestId(TEST_IDS.overlayContent);
      expect(content.querySelector('.rounded-full')).not.toBeInTheDocument();
    });
  });

  it('renders back button when currentStep > 1 and onBack provided', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        currentStep={2}
        onBack={vi.fn()}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('does not render back button when currentStep is 1', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        currentStep={1}
        onBack={vi.fn()}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
  });

  it('calls onBack when back button is clicked', () => {
    const onBack = vi.fn();
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        currentStep={2}
        onBack={onBack}
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    // Use fireEvent instead of userEvent — vaul's pointer event handling
    // throws in JSDOM because getComputedStyle returns no transform value.
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('suppresses auto-focus by default', async () => {
    const onOpenAutoFocus = vi.fn();
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <input data-testid="test-input" />
      </OverlayBottomSheet>
    );

    await waitFor(() => {
      expect(onOpenAutoFocus).toHaveBeenCalled();
    });

    const input = screen.getByTestId('test-input');
    expect(input).not.toHaveFocus();
  });

  it('has data-slot attributes', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    expect(screen.getByTestId(TEST_IDS.overlayBackdrop)).toHaveAttribute(
      'data-slot',
      'overlay-backdrop'
    );
    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
      'data-slot',
      'overlay-content'
    );
  });

  it('close button has data-slot="overlay-close" for E2E selector parity', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    const closeButton = screen.getByRole('button', { name: /close/i });
    expect(closeButton).toHaveAttribute('data-slot', 'overlay-close');
  });

  it('has data-overlay-variant="bottom-sheet" on content', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    expect(screen.getByTestId(TEST_IDS.overlayContent)).toHaveAttribute(
      'data-overlay-variant',
      'bottom-sheet'
    );
  });

  it('has blur effect on overlay', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    const overlay = screen.getByTestId(TEST_IDS.overlayBackdrop);
    expect(overlay).toHaveClass('backdrop-blur-sm');
  });

  it('constrains children to available height via flex layout', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div data-testid="child">Sheet content</div>
      </OverlayBottomSheet>
    );

    // The child's parent (children wrapper) should be a flex column
    const child = screen.getByTestId('child');
    const childrenWrapper = child.parentElement!;
    expect(childrenWrapper.className).toContain('flex-col');
    expect(childrenWrapper.className).toContain('min-h-0');
    expect(childrenWrapper.className).toContain('flex-1');
  });

  it('lets its body scroll when the content cannot shrink to the sheet', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div data-testid="child">Sheet content</div>
      </OverlayBottomSheet>
    );

    // The region under the handle scrolls, so a clip never cuts through the content's own edge.
    const region = screen.getByTestId('child').parentElement?.parentElement;
    expect(region).toHaveClass('overflow-y-auto');
    expect(region).not.toHaveClass('overflow-hidden');
  });

  it('positions the close button against the sheet itself', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    const sheet = screen.getByTestId(TEST_IDS.overlayContent);
    const positioned: Element[] = [];
    for (
      let element = screen.getByRole('button', { name: 'Close' }).parentElement;
      element !== null && element !== sheet;
      element = element.parentElement
    ) {
      if (element.classList.contains('relative')) positioned.push(element);
    }
    expect(positioned).toEqual([]);
  });

  it('applies bottom sheet positioning', () => {
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open={true}
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
      >
        <div>Sheet content</div>
      </OverlayBottomSheet>
    );

    const content = screen.getByTestId(TEST_IDS.overlayContent);
    expect(content).toHaveClass('bottom-0');
    expect(content).toHaveClass('rounded-t-xl');
  });

  it('moves focus to the sheet itself when it opens', async () => {
    const user = userEvent.setup();
    render(<SheetFromPage />);

    await user.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveFocus();
    });
  });

  it('keeps focus on the sheet itself when a field is named for initial focus', async () => {
    function SheetWithNamedField(): React.JSX.Element {
      const nameRef = React.useRef<HTMLInputElement>(null);
      return (
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Test sheet"
          initialFocus={nameRef}
        >
          <input ref={nameRef} aria-label="Name" />
        </OverlayBottomSheet>
      );
    }
    render(<SheetWithNamedField />);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveFocus();
    });
  });

  it('keeps Tab inside the open sheet', async () => {
    const user = userEvent.setup();
    render(<SheetFromPage />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const sheet = await screen.findByRole('dialog');

    for (let press = 0; press < 5; press += 1) {
      await user.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }
  });

  describe('Shift+Tab from the sheet itself', () => {
    it('moves focus to the last control in the sheet', async () => {
      const user = userEvent.setup();
      await openSheetHolding(
        <>
          <button type="button">First</button>
          <button type="button">Second</button>
        </>
      );

      await user.tab({ shift: true });

      expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    });

    it('cycles backwards through the sheet on repeated presses', async () => {
      const user = userEvent.setup();
      await openSheetHolding(
        <>
          <button type="button">First</button>
          <button type="button">Second</button>
          <button type="button">Third</button>
        </>
      );
      const landed: (string | null)[] = [];

      for (let press = 0; press < 4; press += 1) {
        await user.tab({ shift: true });
        landed.push(document.activeElement?.textContent ?? null);
      }

      expect(landed).toEqual(['Third', 'Second', 'First', 'Third']);
    });

    it('skips a last control that cannot take focus', async () => {
      const user = userEvent.setup();
      await openSheetHolding(
        <>
          <button type="button">First</button>
          <button type="button">Second</button>
          <button type="button" disabled>
            Unavailable
          </button>
        </>
      );

      await user.tab({ shift: true });

      expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    });

    it('keeps focus on the sheet when it holds no control', async () => {
      const user = userEvent.setup();
      const sheet = await openSheetHolding(<p>Nothing to press</p>);

      await user.tab({ shift: true });

      expect(sheet).toHaveFocus();
    });

    it('reports no error when the sheet holds no control', async () => {
      const user = userEvent.setup();
      await openSheetHolding(<p>Nothing to press</p>);
      const errors: unknown[] = [];
      const record = (event: ErrorEvent): void => {
        errors.push(event.error);
      };
      globalThis.addEventListener('error', record);

      await user.tab({ shift: true });

      globalThis.removeEventListener('error', record);
      expect(errors).toEqual([]);
    });
  });

  it('moves Tab from the sheet itself straight to the first control in the sheet', async () => {
    const user = userEvent.setup();
    const sheet = await openSheetHolding(
      <>
        <button type="button">First</button>
        <button type="button">Second</button>
      </>
    );
    const focused: (string | null)[] = [];
    sheet.addEventListener('focusin', (event) => {
      focused.push(event.target instanceof HTMLElement ? event.target.textContent : null);
    });

    await user.tab();

    expect(focused).toEqual(['First']);
  });

  it('reveals the first control when Tab wraps from the last control', async () => {
    const user = userEvent.setup();
    await openSheetHolding(
      <>
        <button type="button">First</button>
        <button type="button">Middle</button>
        <button type="button">Last</button>
      </>
    );
    screen.getByRole('button', { name: 'Last' }).focus();
    const first = screen.getByRole('button', { name: 'First' });
    const scrollIntoView = vi.spyOn(first, 'scrollIntoView');

    await user.tab();

    expect(first).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('reveals the last control when Shift+Tab wraps from the first control', async () => {
    const user = userEvent.setup();
    await openSheetHolding(
      <>
        <button type="button">First</button>
        <button type="button">Middle</button>
        <button type="button">Last</button>
      </>
    );
    screen.getByRole('button', { name: 'First' }).focus();
    const last = screen.getByRole('button', { name: 'Last' });
    const scrollIntoView = vi.spyOn(last, 'scrollIntoView');

    await user.tab({ shift: true });

    expect(last).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('leaves focus on the sheet itself when Shift is pressed alone', async () => {
    const user = userEvent.setup();
    const sheet = await openSheetHolding(
      <>
        <button type="button">First</button>
        <button type="button">Second</button>
      </>
    );

    await user.keyboard('{Shift}');

    expect(sheet).toHaveFocus();
  });

  describe('accessible description', () => {
    it('names the header description as the sheet description', async () => {
      render(
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Change password"
        >
          <OverlayHeader title="Change password" description="Other devices sign out." />
        </OverlayBottomSheet>
      );

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Other devices sign out.');
      });
    });

    it('has no accessible description when the header has none', async () => {
      render(
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Invite"
        >
          <OverlayHeader title="Invite" />
        </OverlayBottomSheet>
      );

      const sheet = await screen.findByRole('dialog');

      expect(sheet).not.toHaveAttribute('aria-describedby');
    });

    it('drops the description when the header that drew it unmounts', async () => {
      const { rerender } = render(
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Invite"
        >
          <OverlayHeader title="Invite" description="Send a link." />
        </OverlayBottomSheet>
      );
      const sheet = await screen.findByRole('dialog');
      await waitFor(() => {
        expect(sheet).toHaveAccessibleDescription('Send a link.');
      });

      rerender(
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
          ariaLabel="Invite"
        >
          <OverlayHeader title="Invite" />
        </OverlayBottomSheet>
      );

      await waitFor(() => {
        expect(sheet).not.toHaveAttribute('aria-describedby');
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
          <OverlayBottomSheet
            returnFocus={vi.fn()}
            open={true}
            onOpenChange={vi.fn()}
            ariaLabel="Invite"
          >
            <OverlayHeader title="Invite" description={description} />
          </OverlayBottomSheet>
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

describe('OverlayBottomSheet portal', () => {
  it('portals the sheet to the document body when given no container', () => {
    const { container } = render(
      <OverlayBottomSheet returnFocus={vi.fn()} open onOpenChange={vi.fn()} ariaLabel="Test sheet">
        <p>Body</p>
      </OverlayBottomSheet>
    );

    const sheet = screen.getByTestId(TEST_IDS.overlayContent);
    expect(container).not.toContainElement(sheet);
    expect(sheet.parentElement).toBe(document.body);
  });

  it('portals the sheet into the container it is given', () => {
    const target = portalTarget();
    render(
      <OverlayBottomSheet
        returnFocus={vi.fn()}
        open
        onOpenChange={vi.fn()}
        ariaLabel="Test sheet"
        container={target}
      >
        <p>Body</p>
      </OverlayBottomSheet>
    );

    expect(target).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });

  it('portals the sheet into the element its provider gives', () => {
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open
          onOpenChange={vi.fn()}
          ariaLabel="Test sheet"
        >
          <p>Body</p>
        </OverlayBottomSheet>
      </PortalContainerProvider>
    );

    expect(target).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });

  it('portals the sheet into its own container over the provider', () => {
    const provided = portalTarget();
    const own = portalTarget();
    render(
      <PortalContainerProvider container={provided}>
        <OverlayBottomSheet
          returnFocus={vi.fn()}
          open
          onOpenChange={vi.fn()}
          ariaLabel="Test sheet"
          container={own}
        >
          <p>Body</p>
        </OverlayBottomSheet>
      </PortalContainerProvider>
    );

    expect(own).toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
    expect(provided).not.toContainElement(screen.getByTestId(TEST_IDS.overlayContent));
  });

  it('is published from the package entry', () => {
    expect(PublishedOverlayBottomSheet).toBe(OverlayBottomSheet);
  });
});
