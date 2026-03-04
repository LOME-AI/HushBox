import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IconBackground } from './icon-background';

describe('IconBackground', () => {
  it('renders a container with data-testid', () => {
    render(<IconBackground />);
    expect(screen.getByTestId('icon-background')).toBeInTheDocument();
  });

  it('fills the viewport', () => {
    render(<IconBackground />);
    const container = screen.getByTestId('icon-background');
    expect(container).toHaveStyle({ width: '100vw', height: '100vh' });
  });

  it('has solid dark background', () => {
    render(<IconBackground />);
    const container = screen.getByTestId('icon-background');
    expect(container).toHaveStyle({ backgroundColor: '#0a0a0a' });
  });

  it('has no children', () => {
    render(<IconBackground />);
    const container = screen.getByTestId('icon-background');
    expect(container.children).toHaveLength(0);
  });
});
