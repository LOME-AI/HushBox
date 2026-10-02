import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HIT_AREA_CLASSES } from '../button/icon-button';
import { useFormFactor } from '../platform/use-form-factor';
import { SidebarPanel, SidebarPanelHeader, useSidebarDrawer } from './sidebar-panel';

import type { FormFactor } from '../platform/use-form-factor';

vi.mock('../platform/use-form-factor', () => ({
  useFormFactor: vi.fn((): FormFactor => ({ band: 'desktop', pointer: 'fine' })),
}));

const mockUseFormFactor = vi.mocked(useFormFactor);

function setBand(band: FormFactor['band']): void {
  mockUseFormFactor.mockReturnValue({ band, pointer: 'fine' });
}

function DrawerProbe({
  onReport,
}: Readonly<{ onReport: (isDrawer: boolean) => void }>): React.JSX.Element {
  const drawer = useSidebarDrawer();
  onReport(drawer.isDrawer);
  return (
    <button type="button" onClick={drawer.close}>
      Probe close
    </button>
  );
}

vi.mock('../primitives/sheet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primitives/sheet')>();
  return {
    ...actual,
    Sheet: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) =>
      open ? (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- test mock — div onClick is intentional to simulate Sheet outside-click closing behavior
        <div data-testid="mock-sheet" data-open={open} onClick={() => onOpenChange?.(false)}>
          {children}
        </div>
      ) : null,
    SheetContent: ({
      children,
      side,
      className,
      showCloseButton,
      ...rest
    }: {
      children: React.ReactNode;
      side?: string;
      className?: string;
      showCloseButton?: boolean;
    } & Record<string, unknown>) => (
      <div
        data-testid="mock-sheet-content"
        data-side={side}
        data-show-close-button={String(showCloseButton ?? true)}
        className={className}
        {...rest}
      >
        {showCloseButton !== false && (
          <button type="button" aria-label="Close">
            Built-in close
          </button>
        )}
        {children}
      </div>
    ),
    SheetTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <h2 data-slot="sheet-title" className={className}>
        {children}
      </h2>
    ),
  };
});

const defaultProps = {
  side: 'left' as const,
  open: true,
  onOpenChange: vi.fn(),
  onClose: vi.fn(),
  children: <div data-testid="test-children">Child content</div>,
};

describe('SidebarPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBand('desktop');
  });

  describe('desktop rendering', () => {
    it('renders aside element on desktop for left side', () => {
      render(<SidebarPanel {...defaultProps} side="left" />);
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });

    it('renders aside element on desktop for right side', () => {
      render(<SidebarPanel {...defaultProps} side="right" />);
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });

    it('applies bg-sidebar class on desktop', () => {
      render(<SidebarPanel {...defaultProps} />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('bg-sidebar');
    });

    it('reports the left panel expanded when not collapsed', () => {
      render(<SidebarPanel {...defaultProps} side="left" />);
      expect(screen.getByRole('button', { expanded: true })).toHaveAccessibleName('Close sidebar');
    });

    it('reports the left panel collapsed when collapsed', () => {
      render(<SidebarPanel {...defaultProps} side="left" collapsed={true} />);
      expect(screen.getByRole('button', { expanded: false })).toHaveAccessibleName(
        'Expand sidebar'
      );
    });

    it('reports the right panel expanded when not collapsed', () => {
      render(<SidebarPanel {...defaultProps} side="right" collapsed={false} />);
      expect(screen.getByRole('button', { expanded: true })).toHaveAccessibleName('Close sidebar');
    });

    it('reports the right panel collapsed when collapsed', () => {
      render(<SidebarPanel {...defaultProps} side="right" collapsed={true} />);
      expect(screen.getByRole('button', { expanded: false })).toHaveAccessibleName(
        'Expand sidebar'
      );
    });

    it('leaves a collapsed sidebar readable by assistive technology', () => {
      render(
        <SidebarPanel {...defaultProps} side="right" collapsed={true} testId="test-sidebar" />
      );
      expect(screen.getByTestId('test-sidebar')).not.toHaveAttribute('aria-hidden');
    });

    it('right sidebar has border-l class', () => {
      render(<SidebarPanel {...defaultProps} side="right" />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('border-l');
    });

    it('right sidebar uses responsive visibility classes', () => {
      render(<SidebarPanel {...defaultProps} side="right" testId="test-sidebar" />);
      const aside = screen.getByTestId('test-sidebar');
      expect(aside).toHaveClass('hidden');
      expect(aside).toHaveClass('md:flex');
    });

    it('uses h-full so height inherits from the root h-dvh flex chain (app-wide banner must not push content off-screen)', () => {
      render(<SidebarPanel {...defaultProps} testId="panel" />);
      const aside = screen.getByTestId('panel');
      expect(aside).toHaveClass('h-full');
      expect(aside.className).not.toMatch(/\bh-dvh\b/);
    });

    it('has transition-[width] class for animation', () => {
      render(<SidebarPanel {...defaultProps} />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('transition-[width]');
    });

    it('has data-chrome attribute on desktop aside for reader-mode hiding', () => {
      render(<SidebarPanel {...defaultProps} />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveAttribute('data-chrome', '');
    });
  });

  describe('header', () => {
    it('uses the shared app-header-height token to grow with content (parity with PageHeader)', () => {
      render(<SidebarPanel {...defaultProps} testId="panel" />);
      const header = screen.getByTestId('panel-header');
      expect(header).toHaveClass('min-h-[var(--app-header-height)]');
      expect(header.className).not.toMatch(/\b[hm][a-z-]*-\[53px\]\b/);
    });

    it('has py-2 vertical padding (parity with PageHeader)', () => {
      render(<SidebarPanel {...defaultProps} testId="panel" />);
      const header = screen.getByTestId('panel-header');
      expect(header).toHaveClass('py-2');
    });

    it('left titleGroup has h-9 to match PageHeader tallest control (ModelSelectorButton)', () => {
      render(<SidebarPanel {...defaultProps} side="left" headerTitle="Chats" testId="panel" />);
      const header = screen.getByTestId('panel-header');
      const titleGroup = header.firstElementChild!;
      expect(titleGroup).toHaveClass('h-9');
    });

    it('right titleGroup has h-9 to match PageHeader tallest control (ModelSelectorButton)', () => {
      render(<SidebarPanel {...defaultProps} side="right" headerTitle="Members" testId="panel" />);
      const header = screen.getByTestId('panel-header');
      const titleGroup = header.children[1]!;
      expect(titleGroup).toHaveClass('h-9');
    });

    it('collapsed-state button is a 2.25rem square to keep parity when only one child is present', () => {
      render(<SidebarPanel {...defaultProps} collapsed={true} testId="panel" />);
      const header = screen.getByTestId('panel-header');
      const button = header.firstElementChild!;
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveClass('size-9');
    });

    it('renders close button in header', () => {
      render(<SidebarPanel {...defaultProps} />);
      expect(screen.getByLabelText('Close sidebar')).toBeInTheDocument();
    });

    it('calls onClose when close button clicked', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<SidebarPanel {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByLabelText('Close sidebar'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('left header renders close button as last element', () => {
      render(<SidebarPanel {...defaultProps} side="left" headerTitle="Chats" testId="panel" />);
      const header = screen.getByTestId('panel-header');
      const lastChild = header.lastElementChild!;
      expect(lastChild.tagName).toBe('BUTTON');
      expect(lastChild).toHaveAttribute('aria-label', 'Close sidebar');
    });

    it('right header renders close button as first element', () => {
      render(<SidebarPanel {...defaultProps} side="right" headerTitle="Members" testId="panel" />);
      const header = screen.getByTestId('panel-header');
      expect(header.children[0]!.tagName).toBe('BUTTON');
      expect(header.children[0]!).toHaveAttribute('aria-label', 'Close sidebar');
    });

    it('renders headerIcon in header when provided', () => {
      render(
        <SidebarPanel {...defaultProps} headerIcon={<span data-testid="header-icon">Icon</span>} />
      );
      expect(screen.getByTestId('header-icon')).toBeInTheDocument();
    });

    it('renders headerTitle in header when provided', () => {
      render(<SidebarPanel {...defaultProps} headerTitle="Test Title" />);
      expect(screen.getByText('Test Title')).toBeInTheDocument();
    });
  });

  describe('body and footer', () => {
    it('renders children in body', () => {
      render(<SidebarPanel {...defaultProps} />);
      expect(screen.getByTestId('test-children')).toBeInTheDocument();
      expect(screen.getByText('Child content')).toBeInTheDocument();
    });

    it('renders footer when provided', () => {
      render(
        <SidebarPanel {...defaultProps} footer={<div data-testid="test-footer">Footer</div>} />
      );
      expect(screen.getByTestId('test-footer')).toBeInTheDocument();
    });

    it('does not render footer when not provided', () => {
      render(<SidebarPanel {...defaultProps} />);
      expect(screen.queryByTestId('test-footer')).not.toBeInTheDocument();
    });
  });

  describe('mobile rendering', () => {
    beforeEach(() => {
      setBand('phone');
    });

    it('renders Sheet on mobile', () => {
      render(<SidebarPanel {...defaultProps} open={true} />);
      expect(screen.getByTestId('mock-sheet')).toBeInTheDocument();
    });

    it('passes side prop to Sheet', () => {
      render(<SidebarPanel {...defaultProps} side="right" open={true} />);
      const sheetContent = screen.getByTestId('mock-sheet-content');
      expect(sheetContent).toHaveAttribute('data-side', 'right');
    });

    it('passes showCloseButton=false to SheetContent', () => {
      render(<SidebarPanel {...defaultProps} open={true} />);
      const sheetContent = screen.getByTestId('mock-sheet-content');
      expect(sheetContent).toHaveAttribute('data-show-close-button', 'false');
    });

    it('renders exactly one close button on mobile', () => {
      render(<SidebarPanel {...defaultProps} open={true} />);
      const closeButtons = screen.getAllByRole('button', { name: /close/i });
      expect(closeButtons).toHaveLength(1);
      expect(closeButtons[0]).toHaveAttribute('aria-label', 'Close sidebar');
    });

    it('has data-chrome attribute on mobile SheetContent for reader-mode hiding', () => {
      render(<SidebarPanel {...defaultProps} open={true} />);
      const sheetContent = screen.getByTestId('mock-sheet-content');
      expect(sheetContent).toHaveAttribute('data-chrome', '');
    });

    it('renders a visually-hidden SheetTitle so Radix Dialog has an accessible name', () => {
      render(<SidebarPanel {...defaultProps} open={true} ariaLabel="Conversations" />);
      const title = screen.getByText('Conversations', { selector: '[data-slot="sheet-title"]' });
      expect(title).toBeInTheDocument();
      expect(title).toHaveClass('sr-only');
    });

    it('falls back to a generic SheetTitle when ariaLabel is omitted', () => {
      render(<SidebarPanel {...defaultProps} open={true} />);
      const title = screen.getByText('Sidebar', { selector: '[data-slot="sheet-title"]' });
      expect(title).toBeInTheDocument();
    });
  });

  describe('collapse state exposure', () => {
    // ARIA 1.2 does not list aria-expanded among the properties `complementary`
    // supports, so the disclosure state belongs on the control that toggles it,
    // never on the region itself.
    it('carries the collapse state on the toggle rather than on the region', () => {
      render(<SidebarPanel {...defaultProps} collapsed={true} testId="panel" />);
      const aside = screen.getByTestId('panel');
      expect(aside).not.toHaveAttribute('aria-expanded');
      expect(aside.firstElementChild!).not.toHaveAttribute('aria-expanded');
    });

    it('claims no collapse state on the mobile sheet close button', () => {
      setBand('phone');
      render(<SidebarPanel {...defaultProps} open={true} />);
      expect(screen.getByRole('button', { name: 'Close sidebar' })).not.toHaveAttribute(
        'aria-expanded'
      );
    });

    it('claims no collapse state on a header outside a collapsible panel', () => {
      render(<SidebarPanelHeader side="left" collapsed={false} onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Close sidebar' })).not.toHaveAttribute(
        'aria-expanded'
      );
    });
  });

  describe('width per band', () => {
    it('opens the phone drawer across the full screen width', () => {
      setBand('phone');
      render(<SidebarPanel {...defaultProps} open={true} />);
      const sheetContent = screen.getByTestId('mock-sheet-content');
      expect(sheetContent).toHaveClass('w-full', 'sm:max-w-none');
      expect(sheetContent).not.toHaveClass('w-72');
    });

    it('opens the right phone drawer across the full screen width', () => {
      setBand('phone');
      render(<SidebarPanel {...defaultProps} side="right" open={true} />);
      expect(screen.getByTestId('mock-sheet-content')).toHaveClass('w-full', 'sm:max-w-none');
    });

    it('draws the desktop rail 3.5rem wide', () => {
      render(<SidebarPanel {...defaultProps} collapsed={true} testId="panel" />);
      const aside = screen.getByTestId('panel');
      expect(aside).toHaveClass('w-14');
      expect(aside.firstElementChild!).toHaveClass('min-w-14');
    });

    it('draws the open desktop panel 18rem wide', () => {
      render(<SidebarPanel {...defaultProps} testId="panel" />);
      const aside = screen.getByTestId('panel');
      expect(aside).toHaveClass('w-72');
      expect(aside.firstElementChild!).toHaveClass('min-w-72');
    });
  });

  describe('head controls per band', () => {
    it('draws the left collapse control as the panel icon from 768', () => {
      render(<SidebarPanel {...defaultProps} side="left" />);
      const control = screen.getByRole('button', { name: 'Close sidebar' });
      expect(control.querySelector('svg.lucide-panel-left')).not.toBeNull();
    });

    it('keeps the X on the right close control from 768', () => {
      render(<SidebarPanel {...defaultProps} side="right" />);
      const control = screen.getByRole('button', { name: 'Close sidebar' });
      expect(control.querySelector('svg.lucide-x')).not.toBeNull();
    });

    it('draws a close X on the left phone drawer', () => {
      setBand('phone');
      render(<SidebarPanel {...defaultProps} side="left" open={true} />);
      const control = screen.getByRole('button', { name: 'Close sidebar' });
      expect(control.querySelector('svg.lucide-x')).not.toBeNull();
    });

    it('draws a close X on a header outside a collapsible panel', () => {
      render(<SidebarPanelHeader side="left" collapsed={false} onClose={vi.fn()} />);
      const control = screen.getByRole('button', { name: 'Close sidebar' });
      expect(control.querySelector('svg.lucide-x')).not.toBeNull();
    });

    it('keeps the head control a 2.25rem square with a 2.75rem touch target laid over it', () => {
      render(<SidebarPanel {...defaultProps} side="left" />);
      const control = screen.getByRole('button', { name: 'Close sidebar' });
      expect(control).toHaveClass('size-9', 'pointer-coarse:before:size-11');
    });

    it('fits the rail head without horizontal padding', () => {
      render(<SidebarPanel {...defaultProps} collapsed={true} testId="panel" />);
      expect(screen.getByTestId('panel-header')).toHaveClass('px-0');
    });
  });

  describe('compact head', () => {
    function renderCompactHead(): HTMLElement {
      render(
        <SidebarPanelHeader
          side="left"
          collapsed={false}
          compact
          headerTitle="Accessibility"
          onClose={vi.fn()}
          testId="panel"
        />
      );
      return screen.getByRole('button', { name: 'Close sidebar' });
    }

    it('draws a 1.5rem close control', () => {
      const control = renderCompactHead();
      expect(control).toHaveClass('p-1');
      expect(control).not.toHaveClass('size-9');
      expect(control.querySelector('svg.lucide-x')).toHaveClass('h-4', 'w-4');
    });

    it('draws the close control without the icon button tile', () => {
      const control = renderCompactHead();
      expect(control).not.toHaveAttribute('data-slot', 'icon-button');
      expect(control).toHaveClass('hover:bg-sidebar-border/50', 'rounded');
    });

    it('keeps even 1rem insets', () => {
      renderCompactHead();
      const header = screen.getByTestId('panel-header');
      expect(header).toHaveClass('px-4');
      expect(header).not.toHaveClass('pr-2');
    });

    it('lays a 2.75rem touch target over the close control on a coarse pointer', () => {
      const control = renderCompactHead();
      expect(control).toHaveClass('relative', 'pointer-coarse:before:size-11');
    });

    it("lays the icon button's own extend recipe over the compact close control", () => {
      const control = renderCompactHead();
      expect(control).toHaveClass(...HIT_AREA_CLASSES.extend.split(' '));
    });

    it('puts the compact close control first on the right side', () => {
      render(
        <SidebarPanelHeader
          side="right"
          collapsed={false}
          compact
          headerTitle="Members"
          onClose={vi.fn()}
          testId="panel"
        />
      );
      const header = screen.getByTestId('panel-header');
      expect(header.firstElementChild).toHaveAccessibleName('Close sidebar');
      expect(header).toHaveClass('px-4');
    });

    it('draws the icon button head when compact is not asked for', () => {
      render(<SidebarPanelHeader side="left" collapsed={false} onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Close sidebar' })).toHaveAttribute(
        'data-slot',
        'icon-button'
      );
    });
  });

  describe('head rule', () => {
    it('draws the rule under the head by default', () => {
      render(<SidebarPanel {...defaultProps} testId="panel" />);
      expect(screen.getByTestId('panel-header')).toHaveClass('border-b');
    });

    it('leaves the rule off when the panel turns it off', () => {
      render(<SidebarPanel {...defaultProps} headerRule={false} testId="panel" />);
      expect(screen.getByTestId('panel-header')).not.toHaveClass('border-b');
    });

    it('leaves the rule off in the phone drawer when the panel turns it off', () => {
      setBand('phone');
      render(<SidebarPanel {...defaultProps} headerRule={false} open={true} testId="panel" />);
      expect(screen.getByTestId('panel-header')).not.toHaveClass('border-b');
    });
  });

  // The drawer's dialog semantics come from Radix, so these cases load the frame against
  // the real sheet rather than the flat stand-in the other cases read.
  describe('phone drawer dialog', () => {
    async function loadPanelOnRealSheet(): Promise<typeof SidebarPanel> {
      vi.resetModules();
      vi.doUnmock('../primitives/sheet');
      const formFactor = await import('../platform/use-form-factor');
      vi.mocked(formFactor.useFormFactor).mockReturnValue({ band: 'phone', pointer: 'fine' });
      const module = await import('./sidebar-panel');
      return module.SidebarPanel;
    }

    it('opens as a dialog named by its label', async () => {
      const Panel = await loadPanelOnRealSheet();
      render(<Panel {...defaultProps} open={true} ariaLabel="Conversations" />);
      expect(screen.getByRole('dialog', { name: 'Conversations' })).toBeInTheDocument();
    });

    it('opens without a missing-description warning', async () => {
      const Panel = await loadPanelOnRealSheet();
      const warn = vi.spyOn(console, 'warn');
      render(<Panel {...defaultProps} open={true} ariaLabel="Conversations" />);
      const descriptionWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes('Missing `Description`')
      );
      warn.mockRestore();
      expect(descriptionWarnings).toEqual([]);
    });

    it('points the dialog at no description', async () => {
      const Panel = await loadPanelOnRealSheet();
      render(<Panel {...defaultProps} open={true} ariaLabel="Conversations" />);
      expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
    });
  });

  describe('useSidebarDrawer', () => {
    it('reports the phone drawer', () => {
      setBand('phone');
      const onReport = vi.fn();
      render(
        <SidebarPanel {...defaultProps} open={true}>
          <DrawerProbe onReport={onReport} />
        </SidebarPanel>
      );
      expect(onReport).toHaveBeenLastCalledWith(true);
    });

    it('closes the phone drawer', async () => {
      setBand('phone');
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <SidebarPanel {...defaultProps} open={true} onOpenChange={onOpenChange}>
          <DrawerProbe onReport={vi.fn()} />
        </SidebarPanel>
      );
      await user.click(screen.getByRole('button', { name: 'Probe close' }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('reports no drawer inside the desktop panel', () => {
      const onReport = vi.fn();
      render(
        <SidebarPanel {...defaultProps}>
          <DrawerProbe onReport={onReport} />
        </SidebarPanel>
      );
      expect(onReport).toHaveBeenLastCalledWith(false);
    });

    it('leaves the desktop panel open on close', async () => {
      const onOpenChange = vi.fn();
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        <SidebarPanel {...defaultProps} onOpenChange={onOpenChange} onClose={onClose}>
          <DrawerProbe onReport={vi.fn()} />
        </SidebarPanel>
      );
      await user.click(screen.getByRole('button', { name: 'Probe close' }));
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('reports no drawer outside any panel', async () => {
      const onReport = vi.fn();
      const user = userEvent.setup();
      render(<DrawerProbe onReport={onReport} />);
      await user.click(screen.getByRole('button', { name: 'Probe close' }));
      expect(onReport).toHaveBeenLastCalledWith(false);
    });
  });

  describe('publication', () => {
    it('publishes the drawer hook from the composites barrel', async () => {
      vi.resetModules();
      const own = await import('./sidebar-panel');
      const composites = await import('./index');
      expect(composites.useSidebarDrawer).toBe(own.useSidebarDrawer);
    });

    it('publishes the drawer hook from the package barrel', async () => {
      vi.resetModules();
      const own = await import('./sidebar-panel');
      const packageBarrel = await import('../../index');
      expect(packageBarrel.useSidebarDrawer).toBe(own.useSidebarDrawer);
    });
  });

  describe('testId', () => {
    it('applies testId as data-testid', () => {
      render(<SidebarPanel {...defaultProps} testId="my-panel" />);
      expect(screen.getByTestId('my-panel')).toBeInTheDocument();
    });
  });
});
