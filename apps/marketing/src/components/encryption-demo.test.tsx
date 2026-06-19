import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';

import { EncryptionDemo } from './encryption-demo';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

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

  it('shows cipher text as hex and explanation after toggle', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    expect(screen.getByText(/this is all our servers see/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show readable/i })).toBeInTheDocument();

    const cipherElement = screen.getByTestId(TEST_IDS.cipherOutput);
    expect(cipherElement.textContent).toMatch(/^[0-9a-f]+$/);
  });

  it('displays hex output that differs from plaintext', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    const cipherElement = screen.getByTestId(TEST_IDS.cipherOutput);
    expect(cipherElement.textContent).not.toBe('This is private.');
    expect(cipherElement.textContent.length).toBeGreaterThan(0);
  });

  it('updates cipher text when input changes', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));
    const initialCipher = screen.getByTestId(TEST_IDS.cipherOutput).textContent;

    await user.click(screen.getByRole('button', { name: /show readable/i }));

    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'test');

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    const updatedCipher = screen.getByTestId(TEST_IDS.cipherOutput).textContent;
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

  it('produces a real ECIES ciphertext longer than the plaintext', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo />);

    await user.click(screen.getByRole('button', { name: /show what's stored/i }));

    const hex = screen.getByTestId(TEST_IDS.cipherOutput).textContent;
    expect(hex).toMatch(/^[0-9a-f]+$/);

    const bytes = hexToBytes(hex);
    const plaintextByteLength = new TextEncoder().encode('This is private.').length;
    // Real ECIES wraps the plaintext with an ephemeral X25519 pubkey, nonce,
    // and Poly1305 tag — at least 49 bytes of overhead. Asserting the blob runs
    // well past the plaintext length proves genuine encryption rather than the
    // old static mock, without pinning the exact internal framing byte count.
    expect(bytes.length).toBeGreaterThanOrEqual(plaintextByteLength + 49);
  });

  it('produces a distinct ciphertext on each mount (fresh ephemeral key)', async () => {
    const user = userEvent.setup();

    const first = render(<EncryptionDemo />);
    await user.click(screen.getByRole('button', { name: /show what's stored/i }));
    const firstHex = screen.getByTestId(TEST_IDS.cipherOutput).textContent;
    first.unmount();

    render(<EncryptionDemo />);
    await user.click(screen.getByRole('button', { name: /show what's stored/i }));
    const secondHex = screen.getByTestId(TEST_IDS.cipherOutput).textContent;

    // Real ECIES draws a fresh ephemeral keypair + nonce per encryption, so the
    // same plaintext encrypts to different bytes. A static mock would collide.
    expect(secondHex).not.toBe(firstHex);
  });
});
