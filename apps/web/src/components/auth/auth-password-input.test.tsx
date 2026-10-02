import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { AuthPasswordInput } from './auth-password-input';

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

  it('draws a lock icon hidden from assistive technology', () => {
    const { container } = render(<AuthPasswordInput label="Password" />);
    expect(container.querySelector('svg.lucide-lock')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the field with the control border', () => {
    render(<AuthPasswordInput label="Password" id="password" />);
    expect(screen.getByLabelText('Password')).toHaveClass('border-border-control');
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

  it('floats its label by the input state alone', () => {
    render(<AuthPasswordInput label="Password" id="password" />);
    const label = screen.getByText('Password');
    expect(label).toHaveClass('top-1/2');
    expect([...label.classList].some((token) => token.endsWith(':top-2'))).toBe(true);
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

  it('shows the success line without the field having focus', () => {
    render(<AuthPasswordInput label="Password" id="password" success="Strong password" />);
    // The test DOM computes no Tailwind CSS, so a hidden line is read by its class token.
    expect(screen.getByText('Strong password').closest('.opacity-0')).toBeNull();
  });

  it('describes the field by its message row while it holds a line', () => {
    render(<AuthPasswordInput label="Password" id="password" error="Required" />);
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'aria-describedby',
      'password-message'
    );
  });

  it('lets the caller decide whether the field is invalid', () => {
    render(<AuthPasswordInput label="Password" id="password" aria-invalid />);
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps a description the caller gave', () => {
    render(<AuthPasswordInput label="Password" id="password" aria-describedby="elsewhere" />);
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'elsewhere');
  });

  it('leaves the field without a message when the caller passes none', () => {
    render(
      <AuthPasswordInput label="Password" id="password" error={undefined} success={undefined} />
    );
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-describedby');
  });

  describe('showStrength', () => {
    it('does not render strength indicator by default', () => {
      render(<AuthPasswordInput label="Password" value="test1234" onChange={vi.fn()} />);
      expect(screen.queryByTestId(TEST_IDS.strengthIndicator)).not.toBeInTheDocument();
    });

    it('renders strength indicator when showStrength is true', () => {
      render(
        <AuthPasswordInput label="Password" value="test1234" onChange={vi.fn()} showStrength />
      );
      expect(screen.getByTestId(TEST_IDS.strengthIndicator)).toBeInTheDocument();
    });

    it('shows strength based on password value', () => {
      render(
        <AuthPasswordInput label="Password" value="Test1234!abc" onChange={vi.fn()} showStrength />
      );
      expect(screen.getByText('Strong')).toBeInTheDocument();
    });

    it('falls back to an empty password when value is undefined', () => {
      // Exercises the `String(value ?? '')` nullish fallback: no value prop is
      // passed, so the strength meter still renders against an empty string.
      render(<AuthPasswordInput label="Password" showStrength />);
      expect(screen.getByTestId(TEST_IDS.strengthIndicator)).toBeInTheDocument();
    });
  });
});
