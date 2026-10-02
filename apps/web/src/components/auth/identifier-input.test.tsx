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

  it('shows the error under the field', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} error="Invalid" />);
    expect(screen.getByText('Invalid')).toBeInTheDocument();
  });

  it('shows the success line without the field having focus', () => {
    render(<IdentifierInput value="test" onChange={vi.fn()} success="Valid" />);
    // The test DOM computes no Tailwind CSS, so a hidden line is read by its class token.
    expect(screen.getByText('Valid').closest('.opacity-0')).toBeNull();
  });

  it('draws the field with the control border', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} />);
    expect(screen.getByLabelText('Email or Username')).toHaveClass('border-border-control');
  });

  it('describes the field by its message row', () => {
    render(<IdentifierInput id="identifier" value="" onChange={vi.fn()} error="Invalid" />);
    expect(screen.getByLabelText('Email or Username')).toHaveAttribute(
      'aria-describedby',
      'identifier-message'
    );
  });

  it('leaves the field valid when the caller passes no error', () => {
    render(<IdentifierInput value="" onChange={vi.fn()} error={undefined} success={undefined} />);
    expect(screen.getByLabelText('Email or Username')).not.toHaveAttribute('aria-describedby');
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
