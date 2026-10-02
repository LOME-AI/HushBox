import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RELEASE_STAGE } from '@hushbox/shared';
import { ReleaseStageBadge } from './release-stage-badge';
import type * as React from 'react';

function anchor({ children, ...props }: React.ComponentProps<'a'>): React.JSX.Element {
  return <a {...props}>{children}</a>;
}

describe('ReleaseStageBadge', () => {
  it('shows Beta while the stage is beta', () => {
    render(<ReleaseStageBadge stage="beta" link={anchor} />);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('renders nothing once the stage is stable', () => {
    const { container } = render(<ReleaseStageBadge stage="stable" link={anchor} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('defaults to the release stage the product ships at', () => {
    const implicit = render(<ReleaseStageBadge link={anchor} />).container.innerHTML;
    const explicit = render(<ReleaseStageBadge stage={RELEASE_STAGE} link={anchor} />).container
      .innerHTML;
    expect(implicit).toBe(explicit);
  });

  it('links to the beta section of the Terms', () => {
    render(<ReleaseStageBadge stage="beta" link={anchor} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/terms#beta');
  });

  it('names the link with its visible text first', () => {
    render(<ReleaseStageBadge stage="beta" link={anchor} />);
    expect(screen.getByRole('link', { name: 'Beta: read what that means' })).toBeInTheDocument();
  });

  it('draws the badge in the brand tone', () => {
    render(<ReleaseStageBadge stage="beta" link={anchor} />);
    expect(screen.getByText('Beta')).toHaveClass('bg-primary');
  });
});
