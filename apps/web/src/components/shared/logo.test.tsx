import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo } from './logo';

// Mock TanStack Router's Link component
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe('Logo', () => {
  describe('static display (asLink=false)', () => {
    it('renders the flower logo image', () => {
      render(<Logo />);
      const img = screen.getByAltText('LOME Logo');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', '/assets/images/FlowerHD.png');
    });

    it('renders LOME text', () => {
      render(<Logo />);
      expect(screen.getByText('LOME')).toBeInTheDocument();
    });

    it('is not wrapped in a link by default', () => {
      render(<Logo />);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('applies custom className', () => {
      render(<Logo className="custom-class" />);
      const container = screen.getByTestId('logo');
      expect(container).toHaveClass('custom-class');
    });
  });

  describe('link mode (asLink=true)', () => {
    it('wraps content in a link when asLink is true', () => {
      render(<Logo asLink />);
      expect(screen.getByRole('link')).toBeInTheDocument();
    });

    it('links to /chat by default', () => {
      render(<Logo asLink />);
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', '/chat');
    });

    it('links to custom destination when to prop is provided', () => {
      render(<Logo asLink to="/custom" />);
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', '/custom');
    });

    it('has accessible name for the link', () => {
      render(<Logo asLink />);
      const link = screen.getByRole('link', { name: /lome/i });
      expect(link).toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('has correct image dimensions', () => {
      render(<Logo />);
      const img = screen.getByAltText('LOME Logo');
      expect(img).toHaveClass('h-6', 'w-6');
    });

    it('has correct text styling', () => {
      render(<Logo />);
      const text = screen.getByText('LOME');
      expect(text).toHaveClass('text-primary', 'text-lg', 'font-bold');
    });

    it('has vertical alignment adjustment on image', () => {
      render(<Logo />);
      const img = screen.getByAltText('LOME Logo');
      expect(img).toHaveClass('-translate-y-0.5');
    });
  });
});
