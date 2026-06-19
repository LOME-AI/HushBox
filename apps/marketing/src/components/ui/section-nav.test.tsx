import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SectionNav } from './section-nav';

const SECTIONS = [
  { id: 'intro', label: 'Introduction' },
  { id: 'features', label: 'Features' },
  { id: 'pricing', label: 'Pricing' },
];

describe('SectionNav', () => {
  it('renders all section labels', () => {
    render(<SectionNav sections={SECTIONS} />);
    expect(screen.getByText('Introduction')).toBeInTheDocument();
    expect(screen.getByText('Features')).toBeInTheDocument();
    expect(screen.getByText('Pricing')).toBeInTheDocument();
  });

  it('renders links with correct hrefs', () => {
    render(<SectionNav sections={SECTIONS} />);
    const introLink = screen.getByText('Introduction').closest('a');
    expect(introLink).toHaveAttribute('href', '#intro');
  });

  it('has data-slot attribute', () => {
    render(<SectionNav sections={SECTIONS} data-testid="nav" />);
    expect(screen.getByTestId('nav')).toHaveAttribute('data-slot', 'section-nav');
  });

  it('uses nav semantics', () => {
    render(<SectionNav sections={SECTIONS} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<SectionNav sections={SECTIONS} className="custom-class" data-testid="nav" />);
    expect(screen.getByTestId('nav')).toHaveClass('custom-class');
  });

  it('links have pointer cursor and underline on hover classes', () => {
    render(<SectionNav sections={SECTIONS} />);
    const link = screen.getByText('Introduction').closest('a');
    expect(link).toHaveClass('cursor-pointer');
    expect(link).toHaveClass('hover:underline');
  });
});
