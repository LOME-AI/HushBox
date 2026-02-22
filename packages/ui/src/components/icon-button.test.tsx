import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { IconButton } from './icon-button';

describe('IconButton', () => {
  it('renders children', () => {
    render(
      <IconButton>
        <svg data-testid="test-icon" />
      </IconButton>
    );
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('renders as a button element', () => {
    render(<IconButton>icon</IconButton>);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('applies ghost variant', () => {
    render(<IconButton>icon</IconButton>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'ghost');
  });

  it('applies icon size', () => {
    render(<IconButton>icon</IconButton>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'icon');
  });

  it('has default h-6 w-6 sizing', () => {
    render(<IconButton>icon</IconButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('h-6');
    expect(button).toHaveClass('w-6');
    expect(button).toHaveClass('shrink-0');
  });

  it('accepts className overrides', () => {
    render(<IconButton className="absolute right-1">icon</IconButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('absolute');
    expect(button).toHaveClass('right-1');
  });

  it('forwards ref to button element', () => {
    const ref = vi.fn();
    render(<IconButton ref={ref}>icon</IconButton>);
    expect(ref).toHaveBeenCalled();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton onClick={onClick}>icon</IconButton>);

    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('passes data-testid through', () => {
    render(<IconButton data-testid="my-button">icon</IconButton>);
    expect(screen.getByTestId('my-button')).toBeInTheDocument();
  });

  it('passes aria-label through', () => {
    render(<IconButton aria-label="More options">icon</IconButton>);
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
  });
});
