import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Input } from './input';

describe('Input', () => {
  it('renders input element', () => {
    render(<Input />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders with placeholder', () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('accepts user input', async () => {
    const user = userEvent.setup();
    render(<Input />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'Hello World');
    expect(input).toHaveValue('Hello World');
  });

  it('calls onChange when value changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input onChange={onChange} />);

    await user.type(screen.getByRole('textbox'), 'a');
    expect(onChange).toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(<Input disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('does not accept input when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input disabled onChange={onChange} />);

    await user.type(screen.getByRole('textbox'), 'test');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders without explicit type attribute (browser defaults to text)', () => {
    render(<Input />);
    // Input doesn't set explicit type, browser defaults to text behavior
    const input = screen.getByRole('textbox');
    expect(input.tagName).toBe('INPUT');
  });

  it('renders with type email', () => {
    render(<Input type="email" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('type', 'email');
  });

  it('renders password type', () => {
    render(<Input type="password" data-testid="password-input" />);
    expect(screen.getByTestId('password-input')).toHaveAttribute('type', 'password');
  });

  it('applies custom className', () => {
    render(<Input className="custom-class" />);
    expect(screen.getByRole('textbox')).toHaveClass('custom-class');
  });

  it('forwards ref to input element', () => {
    const ref = vi.fn();
    render(<Input ref={ref} />);
    expect(ref).toHaveBeenCalled();
  });

  it('has data-slot attribute', () => {
    render(<Input />);
    expect(screen.getByRole('textbox')).toHaveAttribute('data-slot', 'input');
  });

  it('accepts defaultValue', () => {
    render(<Input defaultValue="initial" />);
    expect(screen.getByRole('textbox')).toHaveValue('initial');
  });

  it('accepts controlled value', () => {
    render(<Input value="controlled" onChange={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('controlled');
  });

  it('accepts name attribute', () => {
    render(<Input name="email" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('name', 'email');
  });

  it('accepts required attribute', () => {
    render(<Input required />);
    expect(screen.getByRole('textbox')).toBeRequired();
  });

  describe('enhanced input with label and suffix', () => {
    it('renders suffix element', () => {
      render(<Input suffix={<span>icon</span>} />);
      expect(screen.getByTestId('input-suffix')).toBeInTheDocument();
    });

    it('positions suffix at vertical center without label', () => {
      render(<Input suffix={<span>icon</span>} />);
      const suffix = screen.getByTestId('input-suffix');
      expect(suffix).toHaveClass('top-1/2');
      expect(suffix).not.toHaveClass('top-[calc(50%+4px)]');
    });

    it('positions suffix with downward offset when label is present', () => {
      render(<Input label="Password" suffix={<span>icon</span>} value="" onChange={vi.fn()} />);
      const suffix = screen.getByTestId('input-suffix');
      expect(suffix).toHaveClass('top-[calc(50%+4px)]');
      expect(suffix).not.toHaveClass('top-1/2');
    });

    it('renders icon element', () => {
      render(<Input icon={<span>search</span>} />);
      expect(screen.getByTestId('input-icon')).toBeInTheDocument();
    });

    it('renders label element', () => {
      render(<Input label="Email" id="email" value="" onChange={vi.fn()} />);
      expect(screen.getByText('Email')).toBeInTheDocument();
    });
  });
});
