import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ContentSection } from './content-section';

describe('ContentSection', () => {
  it('renders children', () => {
    render(<ContentSection title="Test">Section content</ContentSection>);
    expect(screen.getByText('Section content')).toBeInTheDocument();
  });

  it('renders title as heading', () => {
    render(<ContentSection title="My Title">Content</ContentSection>);
    expect(screen.getByRole('heading', { name: 'My Title' })).toBeInTheDocument();
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
