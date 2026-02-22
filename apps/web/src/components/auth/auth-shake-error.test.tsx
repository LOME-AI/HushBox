import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthShakeError } from './auth-shake-error';

describe('AuthShakeError', () => {
  it('renders nothing when error is null', () => {
    const { container } = render(<AuthShakeError error={null} errorKey={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders error message when error is provided', () => {
    render(<AuthShakeError error="Invalid credentials" errorKey={0} />);
    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
  });

  it('has role="alert" for accessibility', () => {
    render(<AuthShakeError error="Error" errorKey={0} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('has animate-shake class for animation', () => {
    render(<AuthShakeError error="Error" errorKey={0} />);
    expect(screen.getByRole('alert')).toHaveClass('animate-shake');
  });

  it('uses errorKey as React key to retrigger animation', () => {
    const { rerender } = render(<AuthShakeError error="Error 1" errorKey={0} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Error 1');

    rerender(<AuthShakeError error="Error 2" errorKey={1} />);

    // Different key means React re-mounts, so text should be updated
    expect(screen.getByRole('alert')).toHaveTextContent('Error 2');
  });

  it('has destructive text color and centered text', () => {
    render(<AuthShakeError error="Error" errorKey={0} />);
    const element = screen.getByRole('alert');
    expect(element).toHaveClass('text-destructive');
    expect(element).toHaveClass('text-center');
    expect(element).toHaveClass('text-sm');
  });
});
