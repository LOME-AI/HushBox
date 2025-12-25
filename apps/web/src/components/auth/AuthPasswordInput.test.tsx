import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthPasswordInput } from './AuthPasswordInput';

describe('AuthPasswordInput', () => {
  it('renders with label', () => {
    render(<AuthPasswordInput label="Password" />);
    expect(screen.getByText('Password')).toBeInTheDocument();
  });

  it('renders password input with type password by default', () => {
    render(<AuthPasswordInput label="Password" id="password" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
  });

  it('toggles password visibility when button is clicked', async () => {
    const user = userEvent.setup();
    render(<AuthPasswordInput label="Password" id="password" />);

    const input = screen.getByLabelText('Password');
    const toggleButton = screen.getByRole('button', { name: /show password/i });

    expect(input).toHaveAttribute('type', 'password');

    await user.click(toggleButton);
    expect(input).toHaveAttribute('type', 'text');

    await user.click(toggleButton);
    expect(input).toHaveAttribute('type', 'password');
  });

  it('renders lock icon', () => {
    render(<AuthPasswordInput label="Password" />);
    // Icon is rendered by the Input component with testid 'input-icon'
    expect(screen.getByTestId('input-icon')).toBeInTheDocument();
  });

  it('displays error message when provided', () => {
    render(<AuthPasswordInput label="Password" error="Password is required" />);
    expect(screen.getByText('Password is required')).toBeInTheDocument();
  });

  it('passes value to input', () => {
    render(
      <AuthPasswordInput label="Password" id="password" value="secret123" onChange={vi.fn()} />
    );
    const input = screen.getByLabelText('Password');
    expect(input).toHaveValue('secret123');
  });

  it('calls onChange when typing', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(<AuthPasswordInput label="Password" id="password" value="" onChange={handleChange} />);

    const input = screen.getByLabelText('Password');
    await user.type(input, 'a');
    expect(handleChange).toHaveBeenCalled();
  });

  it('has floating label behavior', async () => {
    const user = userEvent.setup();
    render(<AuthPasswordInput label="Password" id="password" />);

    const label = screen.getByText('Password');
    const input = screen.getByLabelText('Password');

    // Before focus
    expect(label).toHaveClass('top-1/2');

    await user.click(input);

    // After focus, label moves up
    expect(label).toHaveClass('top-2');
  });

  it('displays success message when provided', () => {
    render(<AuthPasswordInput label="Password" success="Password meets requirements" />);
    expect(screen.getByText('Password meets requirements')).toBeInTheDocument();
  });

  it('shows error over success when both provided', () => {
    render(<AuthPasswordInput label="Password" error="Too short" success="Valid" />);
    expect(screen.getByText('Too short')).toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
  });

  it('starts with collapsed feedback container', () => {
    render(<AuthPasswordInput label="Password" />);
    // Feedback container is now from AuthInput with testid 'auth-input-feedback'
    const feedbackContainer = screen.getByTestId('auth-input-feedback');
    expect(feedbackContainer).toBeInTheDocument();
    expect(feedbackContainer).toHaveClass('h-0');
  });

  it('expands feedback container when value is present', () => {
    render(<AuthPasswordInput label="Password" value="secret123" onChange={vi.fn()} />);
    // Feedback container is now from AuthInput with testid 'auth-input-feedback'
    const feedbackContainer = screen.getByTestId('auth-input-feedback');
    expect(feedbackContainer).toHaveClass('h-5');
  });
});
