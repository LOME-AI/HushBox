import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { EncryptionDemo } from './encryption-demo';

describe('EncryptionDemo', () => {
  it('has data-slot attribute', () => {
    render(<EncryptionDemo data-testid="demo" />);
    expect(screen.getByTestId('demo')).toHaveAttribute('data-slot', 'encryption-demo');
  });

  it('renders heading', () => {
    render(<EncryptionDemo />);
    expect(screen.getByText('See it for yourself')).toBeInTheDocument();
  });

  it('renders text input with default value', () => {
    render(<EncryptionDemo />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('This is private.');
  });

  it('renders toggle button', () => {
    render(<EncryptionDemo />);
    expect(screen.getByRole('button', { name: /show what's stored/i })).toBeInTheDocument();
  });

  it('shows readable text by default', () => {
    render(<EncryptionDemo />);
    expect(screen.getByText('This is private.')).toBeInTheDocument();
  });

  it('does not show explanation text by default', () => {
    render(<EncryptionDemo />);
    expect(screen.getByText(/this is all our servers see/i)).toHaveClass('opacity-0');
  });

  it('shows cipher text and explanation after toggle', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    expect(screen.getByText(/this is all our servers see/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show readable/i })).toBeInTheDocument();
  });

  it('updates cipher text when input changes', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'test');

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    // btoa('test') = 'dGVzdA=='
    expect(screen.getByText('dGVzdA==')).toBeInTheDocument();
  });

  it('toggles back to readable view', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));
    await user.click(screen.getByRole('button', { name: /show readable/i }));

    expect(screen.getByText(/this is all our servers see/i)).toHaveClass('opacity-0');
    expect(screen.getByRole('button', { name: /show what's stored/i })).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<EncryptionDemo className="custom-class" data-testid="demo" />);
    expect(screen.getByTestId('demo')).toHaveClass('custom-class');
  });
});
