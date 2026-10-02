import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ContentSection } from './content-section';

describe('ContentSection', () => {
  it('renders children', () => {
    render(<ContentSection title="Test">Section content</ContentSection>);
    expect(screen.getByText('Section content')).toBeInTheDocument();
  });

  it('renders title as a second-level heading', () => {
    render(<ContentSection title="My Title">Content</ContentSection>);
    expect(screen.getByRole('heading', { name: 'My Title', level: 2 })).toBeInTheDocument();
  });

  it('sets its title in the site subhead type role', () => {
    render(<ContentSection title="My Title">Content</ContentSection>);
    expect(screen.getByRole('heading', { name: 'My Title' })).toHaveClass(
      'text-site-subhead',
      'font-serif'
    );
  });

  it('names its region by its title', () => {
    render(<ContentSection title="My Title">Content</ContentSection>);
    expect(screen.getByRole('region', { name: 'My Title' })).toBeInTheDocument();
  });

  it('stops an anchor jump clear of the fixed header', () => {
    render(
      <ContentSection title="Title" data-testid="section">
        Content
      </ContentSection>
    );
    expect(screen.getByTestId('section')).toHaveClass('scroll-mt-24');
  });

  it('breaks a word wider than its column rather than scrolling the page', () => {
    render(
      <ContentSection title="Title" data-testid="section">
        Content
      </ContentSection>
    );
    expect(screen.getByTestId('section')).toHaveClass('wrap-break-word');
  });

  it('has data-slot attribute', () => {
    render(
      <ContentSection title="Title" data-testid="section">
        Content
      </ContentSection>
    );
    expect(screen.getByTestId('section')).toHaveAttribute('data-slot', 'content-section');
  });

  it('applies id prop for anchor links', () => {
    render(
      <ContentSection title="Title" id="my-section" data-testid="section">
        Content
      </ContentSection>
    );
    expect(screen.getByTestId('section')).toHaveAttribute('id', 'my-section');
  });

  it('applies custom className', () => {
    render(
      <ContentSection title="Title" className="custom-class" data-testid="section">
        Content
      </ContentSection>
    );
    expect(screen.getByTestId('section')).toHaveClass('custom-class');
  });
});
