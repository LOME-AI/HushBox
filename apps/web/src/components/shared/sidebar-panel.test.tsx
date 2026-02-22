import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarPanel } from './sidebar-panel';

// Mock useIsMobile hook
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

import { useIsMobile } from '@/hooks/use-is-mobile';

const mockUseIsMobile = vi.mocked(useIsMobile);

// Mock Sheet components from @hushbox/ui
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
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
        <div data-testid="mock-sheet" data-open={open} onClick={() => onOpenChange?.(false)}>
          {children}
        </div>
      ) : null,
    SheetContent: ({
      children,
      side,
      className,
      showCloseButton,
    }: {
      children: React.ReactNode;
      side?: string;
      className?: string;
      showCloseButton?: boolean;
    }) => (
      <div
        data-testid="mock-sheet-content"
        data-side={side}
        data-show-close-button={String(showCloseButton ?? true)}
        className={className}
      >
        {showCloseButton !== false && (
          <button type="button" aria-label="Close">
            Built-in close
          </button>
        )}
        {children}
      </div>
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
    mockUseIsMobile.mockReturnValue(false);
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

    it('left sidebar uses w-72 when not collapsed', () => {
      render(<SidebarPanel {...defaultProps} side="left" />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-72');
    });

    it('left sidebar uses w-12 when collapsed', () => {
      render(<SidebarPanel {...defaultProps} side="left" collapsed={true} />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-12');
    });

    it('right sidebar uses w-72 when not collapsed', () => {
      render(<SidebarPanel {...defaultProps} side="right" collapsed={false} />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-72');
    });

    it('right sidebar uses w-12 when collapsed', () => {
      render(
        <SidebarPanel {...defaultProps} side="right" collapsed={true} testId="test-sidebar" />
      );
      const aside = screen.getByTestId('test-sidebar');
      expect(aside).toHaveClass('w-12');
      expect(aside).not.toHaveAttribute('aria-hidden');
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

    it('uses h-dvh for viewport-absolute height (not h-full)', () => {
      render(<SidebarPanel {...defaultProps} testId="panel" />);
      const aside = screen.getByTestId('panel');
      expect(aside).toHaveClass('h-dvh');
      expect(aside.className).not.toMatch(/\bh-full\b/);
    });

    it('has transition-[width] class for animation', () => {
      render(<SidebarPanel {...defaultProps} />);
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('transition-[width]');
    });
  });

  describe('header', () => {
    it('renders header with h-[53px]', () => {
      render(<SidebarPanel {...defaultProps} testId="panel" />);
      const header = screen.getByTestId('panel-header');
      expect(header).toHaveClass('h-[53px]');
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
      mockUseIsMobile.mockReturnValue(true);
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
  });

  describe('inner content wrapper', () => {
    it('has min-w-72 when expanded', () => {
      render(<SidebarPanel {...defaultProps} collapsed={false} testId="panel" />);
      const aside = screen.getByTestId('panel');
      const innerWrapper = aside.firstElementChild!;
      expect(innerWrapper).toHaveClass('min-w-72');
      expect(innerWrapper).not.toHaveClass('min-w-12');
    });

    it('has min-w-12 when collapsed', () => {
      render(<SidebarPanel {...defaultProps} collapsed={true} testId="panel" />);
      const aside = screen.getByTestId('panel');
      const innerWrapper = aside.firstElementChild!;
      expect(innerWrapper).toHaveClass('min-w-12');
      expect(innerWrapper).not.toHaveClass('min-w-72');
    });
  });

  describe('testId', () => {
    it('applies testId as data-testid', () => {
      render(<SidebarPanel {...defaultProps} testId="my-panel" />);
      expect(screen.getByTestId('my-panel')).toBeInTheDocument();
    });
  });
});
