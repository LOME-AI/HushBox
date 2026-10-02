import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('has data-slot attribute', () => {
    render(<EmptyState title="Nothing here" data-testid="empty" />);

    expect(screen.getByTestId('empty')).toHaveAttribute('data-slot', 'empty-state');
  });

  it('renders the title', () => {
    render(<EmptyState title="Nothing here" />);

    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders the description', () => {
    render(<EmptyState title="Nothing here" description="Rule a finding to fill this list." />);

    expect(screen.getByText('Rule a finding to fill this list.')).toBeInTheDocument();
  });

  it('omits the description when none is given', () => {
    const { container } = render(<EmptyState title="Nothing here" />);

    expect(container.querySelector('[data-slot="empty-state-description"]')).toBeNull();
  });

  it('renders the icon', () => {
    render(<EmptyState title="Nothing here" icon={<svg data-testid="icon" />} />);

    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('hides the icon from assistive technology', () => {
    const { container } = render(
      <EmptyState title="Nothing here" icon={<svg data-testid="icon" />} />
    );

    expect(container.querySelector('[data-slot="empty-state-icon"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });

  it('omits the icon slot when no icon is given', () => {
    const { container } = render(<EmptyState title="Nothing here" />);

    expect(container.querySelector('[data-slot="empty-state-icon"]')).toBeNull();
  });

  it('renders the action', () => {
    render(<EmptyState title="Nothing here" action={<button type="button">Add one</button>} />);

    expect(screen.getByRole('button', { name: 'Add one' })).toBeInTheDocument();
  });

  it('omits the action slot when no action is given', () => {
    const { container } = render(<EmptyState title="Nothing here" />);

    expect(container.querySelector('[data-slot="empty-state-action"]')).toBeNull();
  });

  it('applies custom className', () => {
    render(<EmptyState title="Nothing here" className="custom-class" data-testid="empty" />);

    expect(screen.getByTestId('empty')).toHaveClass('custom-class');
  });
});
