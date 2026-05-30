import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@hushbox/crypto', () => {
  const encoder = new TextEncoder();
  return {
    generateKeyPair: vi.fn(() => ({
      publicKey: new Uint8Array(32).fill(0xaa),
      privateKey: new Uint8Array(32).fill(0xbb),
    })),
    encryptTextForEpoch: vi.fn((_, plaintext: string) => {
      const bytes = encoder.encode(plaintext);
      const result = new Uint8Array(bytes.length + 49);
      result[0] = 0x01;
      result.set(new Uint8Array(32).fill(0xcc), 1);
      result.set(bytes, 33);
      result.set(new Uint8Array(16).fill(0xdd), 33 + bytes.length);
      return result;
    }),
  };
});

import { EncryptionDemo } from './encryption-demo';

describe('EncryptionDemo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('shows cipher text as hex and explanation after toggle', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    expect(screen.getByText(/this is all our servers see/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show readable/i })).toBeInTheDocument();

    const cipherElement = screen.getByTestId('cipher-output');
    expect(cipherElement.textContent).toMatch(/^[0-9a-f]+$/);
  });

  it('displays hex output that differs from plaintext', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    const cipherElement = screen.getByTestId('cipher-output');
    expect(cipherElement.textContent).not.toBe('This is private.');
    expect(cipherElement.textContent.length).toBeGreaterThan(0);
  });

  it('updates cipher text when input changes', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));
    const initialCipher = screen.getByTestId('cipher-output').textContent;

    await user.click(screen.getByRole('button', { name: /show readable/i }));

    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'test');

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    const updatedCipher = screen.getByTestId('cipher-output').textContent;
    expect(updatedCipher).not.toBe(initialCipher);
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

  it('calls encryptTextForEpoch with generated key', async () => {
    const { encryptTextForEpoch } = await import('@hushbox/crypto');
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    expect(encryptTextForEpoch).toHaveBeenCalledWith(expect.any(Uint8Array), 'This is private.');
  });
});
