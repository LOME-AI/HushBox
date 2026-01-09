import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormInput } from './form-input';

describe('FormInput', () => {
  it('renders with label', () => {
    render(<FormInput label="Email" />);
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('renders input element', () => {
    render(<FormInput label="Email" />);
    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
  });

  it('renders icon when provided', () => {
    render(<FormInput label="Email" icon={<span data-testid="email-icon">@</span>} />);
    expect(screen.getByTestId('email-icon')).toBeInTheDocument();
  });

  it('does not render icon container when no icon provided', () => {
    render(<FormInput label="Email" />);
    expect(screen.queryByTestId('form-input-icon')).not.toBeInTheDocument();
  });

  it('displays error message when provided', () => {
    render(<FormInput label="Email" error="Invalid email" />);
    expect(screen.getByText('Invalid email')).toBeInTheDocument();
  });

  it('does not display error when not provided', () => {
    render(<FormInput label="Email" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('passes value to input', () => {
    render(<FormInput label="Email" value="test@example.com" onChange={vi.fn()} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('test@example.com');
  });

  it('calls onChange when typing', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(<FormInput label="Email" value="" onChange={handleChange} />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'a');
    expect(handleChange).toHaveBeenCalled();
  });

  it('applies type attribute', () => {
    render(<FormInput label="Email" type="email" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('type', 'email');
  });

  it('can be disabled', () => {
    render(<FormInput label="Email" disabled />);
    const input = screen.getByRole('textbox');
    expect(input).toBeDisabled();
  });

  it('applies custom id', () => {
    render(<FormInput label="Email" id="my-email" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('id', 'my-email');
  });

  it('associates label with input via htmlFor', () => {
    render(<FormInput label="Email" id="my-email" />);
    const label = screen.getByText('Email');
    expect(label).toHaveAttribute('for', 'my-email');
  });

  it('moves label up when input is focused', async () => {
    const user = userEvent.setup();
    render(<FormInput label="Email" id="email" />);

    const label = screen.getByText('Email');
    const input = screen.getByRole('textbox');

    // Before focus, label should be in default position
    expect(label).toHaveClass('top-1/2');

    await user.click(input);

    // After focus, label should move up
    expect(label).toHaveClass('top-2');
    expect(label).not.toHaveClass('top-1/2');
  });

  it('keeps label up when input has value', () => {
    render(<FormInput label="Email" id="email" value="test" onChange={vi.fn()} />);

    const label = screen.getByText('Email');

    // Label should be up because there's a value
    expect(label).toHaveClass('top-2');
    expect(label).not.toHaveClass('top-1/2');
  });

  it('has rounded-lg border radius', () => {
    render(<FormInput label="Email" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('rounded-lg');
  });

  it('applies error styling when error is present', () => {
    render(<FormInput label="Email" error="Required" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('border-destructive');
  });

  it('displays success message when provided', () => {
    render(<FormInput label="Email" success="Valid email" />);
    expect(screen.getByText('Valid email')).toBeInTheDocument();
  });

  it('shows error over success when both provided', () => {
    render(<FormInput label="Email" error="Invalid" success="Valid" />);
    expect(screen.getByText('Invalid')).toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
  });

  it('starts with collapsed feedback container', () => {
    render(<FormInput label="Email" />);
    const feedbackContainer = screen.getByTestId('form-input-feedback');
    expect(feedbackContainer).toBeInTheDocument();
    expect(feedbackContainer).toHaveClass('h-0');
  });

  it('expands feedback container when value is present', () => {
    render(<FormInput label="Email" value="test@example.com" onChange={vi.fn()} />);
    const feedbackContainer = screen.getByTestId('form-input-feedback');
    expect(feedbackContainer).toHaveClass('h-5');
  });

  describe('accessibility', () => {
    it('sets aria-invalid when error is present', () => {
      render(<FormInput label="Email" error="Invalid email" />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });

    it('does not set aria-invalid when no error', () => {
      render(<FormInput label="Email" />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveAttribute('aria-invalid', 'false');
    });

    it('links input to feedback via aria-describedby when error present', () => {
      render(<FormInput label="Email" error="Invalid email" id="email-input" />);
      const input = screen.getByRole('textbox');
      const feedbackId = input.getAttribute('aria-describedby');
      expect(feedbackId).toBe('email-input-feedback');
      expect(document.getElementById(feedbackId ?? '')).toHaveTextContent('Invalid email');
    });

    it('links input to feedback via aria-describedby when success present', () => {
      render(<FormInput label="Email" success="Valid email" id="email-input" />);
      const input = screen.getByRole('textbox');
      const feedbackId = input.getAttribute('aria-describedby');
      expect(feedbackId).toBe('email-input-feedback');
      expect(document.getElementById(feedbackId ?? '')).toHaveTextContent('Valid email');
    });

    it('does not set aria-describedby when no feedback', () => {
      render(<FormInput label="Email" />);
      const input = screen.getByRole('textbox');
      expect(input).not.toHaveAttribute('aria-describedby');
    });
  });
});
