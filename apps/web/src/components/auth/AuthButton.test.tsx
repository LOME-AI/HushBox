import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthButton } from './AuthButton';

describe('AuthButton', () => {
  it('renders children', () => {
    render(<AuthButton>Sign in</AuthButton>);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('applies angled clip-path style', () => {
    render(<AuthButton>Sign in</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveStyle({ clipPath: 'polygon(0 0, 100% 0, 95% 100%, 0 100%)' });
  });

  it('applies font-black class', () => {
    render(<AuthButton>Sign in</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('font-black');
  });

  it('can be disabled', () => {
    render(<AuthButton disabled>Sign in</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });

  it('handles click events', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<AuthButton onClick={handleClick}>Sign in</AuthButton>);

    await user.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('can have type submit', () => {
    render(<AuthButton type="submit">Sign in</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('type', 'submit');
  });

  it('applies custom className', () => {
    render(<AuthButton className="w-full">Sign in</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('w-full');
  });

  it('renders as primary variant by default', () => {
    render(<AuthButton>Sign in</AuthButton>);
    const button = screen.getByRole('button');
    // shadcn Button default variant styling
    expect(button).toHaveClass('bg-primary');
  });

  it('has taller height than default button', () => {
    render(<AuthButton>Sign in</AuthButton>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('h-14');
  });
});
