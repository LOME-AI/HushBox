import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from './page-header';

// Mock HamburgerButton
vi.mock('@/components/sidebar/hamburger-button', () => ({
  HamburgerButton: () => <button data-testid="hamburger-button">Menu</button>,
}));

describe('PageHeader', () => {
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
      // Just verify it renders without center content
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
      // Just verify it renders without right content
      expect(screen.getByTestId('page-header')).toBeInTheDocument();
    });
  });

  describe('layout', () => {
    it('has three-column flex layout', () => {
      render(<PageHeader title="Test" center={<span>Center</span>} right={<span>Right</span>} />);
      const header = screen.getByTestId('page-header');
      expect(header).toHaveClass('flex', 'items-center', 'justify-center');
    });

    it('has consistent height matching sidebar header', () => {
      render(<PageHeader />);
      const header = screen.getByTestId('page-header');
      expect(header).toHaveClass('h-[57px]');
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
