import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdentifierInput } from './identifier-input';

describe('IdentifierInput', () => {
  it('renders with label "Email or Username"', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Email or Username')).toBeInTheDocument();
  });

  it('renders as text type input', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Email or Username')).toHaveAttribute('type', 'text');
  });

  it('sets autoComplete to username', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Email or Username')).toHaveAttribute('autocomplete', 'username');
  });

  it('passes value to input', () => {
    render(<IdentifierInput value="test@example.com" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Email or Username')).toHaveValue('test@example.com');
  });

  it('calls onChange when user types', async () => {
    const onChange = vi.fn();
    render(<IdentifierInput value="" onChange={onChange} />);
    await userEvent.setup().type(screen.getByLabelText('Email or Username'), 'a');
    expect(onChange).toHaveBeenCalled();
  });

  it('passes error to FormInput', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} error="Invalid" />);
    expect(screen.getByText('Invalid')).toBeInTheDocument();
  });

  it('passes success to FormInput', async () => {
    render(<IdentifierInput value="test" onChange={vi.fn()} success="Valid" />);
    // Focus the input to trigger success display
    await userEvent.setup().click(screen.getByLabelText('Email or Username'));
    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('sets aria-invalid when error is present', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} error="Required" />);
    expect(screen.getByLabelText('Email or Username')).toHaveAttribute('aria-invalid', 'true');
  });

  it('uses custom id when provided', () => {
    render(<IdentifierInput id="custom-id" value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Email or Username')).toHaveAttribute('id', 'custom-id');
  });
});
