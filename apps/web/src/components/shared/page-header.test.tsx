import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from './page-header';

// Mock HamburgerButton
vi.mock('@/components/sidebar/hamburger-button', () => ({
  HamburgerButton: () => <button data-testid="hamburger-button">Menu</button>,
}));

// Mock useHeaderLayout — control row count per test
const mockRows = vi.fn<() => 1 | 2 | 3>(() => 1);
vi.mock('@/hooks/use-header-layout', () => ({
  useHeaderLayout: (): 1 | 2 | 3 => mockRows(),
}));

describe('PageHeader', () => {
  beforeEach(() => {
    mockRows.mockReturnValue(1);
  });

  describe('rendering', () => {
    it('renders with data-testid page-header', () => {
      render(<PageHeader />);
      expect(screen.getByTestId('page-header')).toBeInTheDocument();
    });

    it('applies sticky positioning with backdrop blur', () => {
      render(<PageHeader />);
      const header = screen.getByTestId('page-header');
      expect(header).toHaveClass('sticky', 'top-0', 'backdrop-blur');
    });

    it('has overflow-hidden to prevent visual overflow', () => {
      render(<PageHeader />);
      const header = screen.getByTestId('page-header');
      expect(header).toHaveClass('overflow-hidden');
    });
  });

  describe('left slot', () => {
    it('renders hamburger button', () => {
      render(<PageHeader />);
      expect(screen.getByTestId('hamburger-button')).toBeInTheDocument();
    });

    it('renders title in brand color when provided', () => {
      render(<PageHeader title="Billing" />);
      const title = screen.getByTestId('page-header-title');
      expect(title).toHaveTextContent('Billing');
      expect(title).toHaveClass('text-primary');
    });

    it('renders custom left content', () => {
      render(<PageHeader left={<span data-testid="custom-left">Custom</span>} />);
      expect(screen.getByTestId('custom-left')).toBeInTheDocument();
    });

    it('renders title alongside custom left content', () => {
      render(<PageHeader title="Test" left={<span data-testid="custom-left">Custom</span>} />);
      expect(screen.getByTestId('page-header-title')).toHaveTextContent('Test');
      expect(screen.getByTestId('custom-left')).toBeInTheDocument();
    });
  });

  describe('center slot', () => {
    it('renders center content when provided', () => {
      render(<PageHeader center={<span data-testid="custom-center">Center</span>} />);
      expect(screen.getByTestId('custom-center')).toBeInTheDocument();
    });

    it('does not render center area when not provided', () => {
      render(<PageHeader />);
      expect(screen.getByTestId('page-header')).toBeInTheDocument();
    });
  });

  describe('right slot', () => {
    it('renders right content when provided', () => {
      render(<PageHeader right={<span data-testid="custom-right">Right</span>} />);
      expect(screen.getByTestId('custom-right')).toBeInTheDocument();
    });

    it('does not render right area when not provided', () => {
      render(<PageHeader />);
      expect(screen.getByTestId('page-header')).toBeInTheDocument();
    });
  });

  describe('layout', () => {
    it('uses CSS Grid layout for content', () => {
      render(<PageHeader title="Test" center={<span>Center</span>} right={<span>Right</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      expect(grid).toHaveClass('grid', 'items-center', 'content-center');
    });

    it('has minimum height matching sidebar header', () => {
      render(<PageHeader />);
      const header = screen.getByTestId('page-header');
      expect(header).toHaveClass('min-h-[53px]', 'shrink-0');
    });

    it('has symmetric vertical padding', () => {
      render(<PageHeader />);
      const header = screen.getByTestId('page-header');
      expect(header).toHaveClass('py-2');
    });

    it('assigns grid-area left to the left content group', () => {
      render(<PageHeader title="Test" />);
      const grid = screen.getByTestId('page-header-grid');
      const leftArea = grid.children[0] as HTMLElement;
      expect(leftArea.style.gridArea).toBe('left');
    });

    it('assigns grid-area center to the center content group', () => {
      render(<PageHeader center={<span>Center</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      const centerArea = grid.children[1] as HTMLElement;
      expect(centerArea.style.gridArea).toBe('center');
    });

    it('assigns grid-area right to the right content group', () => {
      render(<PageHeader right={<span>Right</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      const rightArea = grid.children[2] as HTMLElement;
      expect(rightArea.style.gridArea).toBe('right');
    });
  });

  describe('adaptive alignment', () => {
    it('in 1-row mode: left=start, center=center, right=end', () => {
      mockRows.mockReturnValue(1);
      render(<PageHeader title="Test" center={<span>Center</span>} right={<span>Right</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      const [leftEl, centerEl, rightEl] = [...grid.children] as HTMLElement[];
      expect(leftEl).toHaveClass('justify-self-start');
      expect(centerEl).toHaveClass('justify-self-center');
      expect(rightEl).toHaveClass('justify-self-end');
    });

    it('in 2-row mode: center=center (alone on row 1), left=start, right=end (sharing row 2)', () => {
      mockRows.mockReturnValue(2);
      render(<PageHeader title="Test" center={<span>Center</span>} right={<span>Right</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      const [leftEl, centerEl, rightEl] = [...grid.children] as HTMLElement[];
      expect(leftEl).toHaveClass('justify-self-start');
      expect(centerEl).toHaveClass('justify-self-center');
      expect(rightEl).toHaveClass('justify-self-end');
    });

    it('in 3-row mode: all items centered', () => {
      mockRows.mockReturnValue(3);
      render(<PageHeader title="Test" center={<span>Center</span>} right={<span>Right</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      const [leftEl, centerEl, rightEl] = [...grid.children] as HTMLElement[];
      expect(leftEl).toHaveClass('justify-self-center');
      expect(centerEl).toHaveClass('justify-self-center');
      expect(rightEl).toHaveClass('justify-self-center');
    });

    it('uses 1fr auto 1fr columns in 1-row mode', () => {
      mockRows.mockReturnValue(1);
      render(<PageHeader center={<span>Center</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      expect(grid.style.gridTemplateColumns).toBe('1fr auto 1fr');
      expect(grid.style.gridTemplateAreas).toBe('"left center right"');
    });

    it('uses two-row grid template in 2-row mode with model selector on top', () => {
      mockRows.mockReturnValue(2);
      render(<PageHeader center={<span>Center</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      expect(grid.style.gridTemplateColumns).toBe('auto 1fr');
      expect(grid.style.gridTemplateAreas).toBe('"center center" "left right"');
    });

    it('uses single-column grid template in 3-row mode with model selector on top', () => {
      mockRows.mockReturnValue(3);
      render(<PageHeader center={<span>Center</span>} />);
      const grid = screen.getByTestId('page-header-grid');
      expect(grid.style.gridTemplateColumns).toBe('1fr');
      expect(grid.style.gridTemplateAreas).toBe('"center" "left" "right"');
    });
  });

  describe('custom test IDs', () => {
    it('uses custom testId when provided', () => {
      render(<PageHeader testId="custom-header" />);
      expect(screen.getByTestId('custom-header')).toBeInTheDocument();
    });

    it('uses custom titleTestId when provided', () => {
      render(<PageHeader title="Test" titleTestId="custom-title" />);
      expect(screen.getByTestId('custom-title')).toHaveTextContent('Test');
    });

    it('uses custom testId for grid element', () => {
      render(<PageHeader testId="custom-header" />);
      expect(screen.getByTestId('custom-header-grid')).toBeInTheDocument();
    });
  });

  describe('brandTitle', () => {
    it('uses brand color by default', () => {
      render(<PageHeader title="Test" />);
      expect(screen.getByTestId('page-header-title')).toHaveClass('text-primary');
    });

    it('does not use brand color when brandTitle is false', () => {
      render(<PageHeader title="Test" brandTitle={false} />);
      expect(screen.getByTestId('page-header-title')).not.toHaveClass('text-primary');
    });
  });
});
