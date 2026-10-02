import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import * as cryptoContent from '@hushbox/crypto/content';

import { DEMO_SAMPLE_TEXT, encryptDemoSample } from '../lib/encryption-demo-sample';
import { EncryptionDemo } from './encryption-demo';
import type { DemoSample } from '../lib/encryption-demo-sample';

// Wraps the real key generator so a test can count the keys the demo draws;
// every key and every blob is still the real one.
vi.mock('@hushbox/crypto/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/crypto/content')>();
  return { ...actual, generateKeyPair: vi.fn(actual.generateKeyPair) };
});

const SAMPLE: DemoSample = encryptDemoSample(DEMO_SAMPLE_TEXT);

function storedPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'What our servers store' });
}

function hex(): string {
  return screen.getByTestId(TEST_IDS.cipherOutput).textContent;
}

describe('EncryptionDemo', () => {
  beforeEach(() => {
    vi.mocked(cryptoContent.generateKeyPair).mockClear();
  });

  it('names the demo "See it for yourself" at heading level three', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(screen.getByRole('heading', { level: 3, name: 'See it for yourself' })).toBeVisible();
  });

  it('draws the typed panel at first render, holding the default text', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(screen.getByRole('textbox', { name: 'What you type' })).toHaveValue(DEMO_SAMPLE_TEXT);
  });

  it('sets the typed text and its label in the interface face, whatever face the page reads in', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(screen.getByText('What you type').closest('.font-sans')).toContainElement(
      screen.getByRole('textbox', { name: 'What you type' })
    );
  });

  it('draws the stored panel at first render, labelled what is stored', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(within(storedPanel()).getByText("What's stored")).toBeVisible();
  });

  it('shows the build-time sample before anyone types', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(hex()).toBe(SAMPLE.hex);
  });

  it('counts the build-time sample in bytes before anyone types', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(within(storedPanel()).getByText('90 bytes')).toBeVisible();
  });

  it('keeps the byte count on one line', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(within(storedPanel()).getByText('90 bytes')).toHaveClass('whitespace-nowrap');
  });

  it('moves the byte count under its label when the two do not fit side by side', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(within(storedPanel()).getByText("What's stored").parentElement).toHaveClass('flex-wrap');
  });

  it('keeps the hex inside the stored panel', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(storedPanel()).toContainElement(screen.getByTestId(TEST_IDS.cipherOutput));
  });

  it('changes the hex as the visitor types', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo initialSample={SAMPLE} />);

    await user.type(screen.getByRole('textbox', { name: 'What you type' }), '!');

    expect(hex()).not.toBe(SAMPLE.hex);
  });

  it('writes the typed text as real hex', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo initialSample={SAMPLE} />);

    await user.type(screen.getByRole('textbox', { name: 'What you type' }), '!');

    expect(hex()).toMatch(/^[0-9a-f]+$/);
  });

  it('counts exactly the bytes the hex spells', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo initialSample={SAMPLE} />);

    await user.type(screen.getByRole('textbox', { name: 'What you type' }), ' Really private.');

    expect(within(storedPanel()).getByText(`${String(hex().length / 2)} bytes`)).toBeVisible();
  });

  it('stores the blob of an emptied field rather than a stand-in word', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo initialSample={SAMPLE} />);

    await user.clear(screen.getByRole('textbox', { name: 'What you type' }));

    expect(hex().length / 2).toBe(encryptDemoSample('').byteLength);
  });

  it('offers no toggle', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the note from the start', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(
      screen.getByText("This is all our servers see. Without your password, it's meaningless.")
    ).toBeVisible();
  });

  it('announces nothing as the visitor types', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('labels the stored panel without making it live', () => {
    render(<EncryptionDemo initialSample={SAMPLE} />);

    expect(storedPanel()).not.toHaveAttribute('aria-live');
  });

  it('draws one demo key per mount, not one per keystroke', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo initialSample={SAMPLE} />);

    await user.type(screen.getByRole('textbox', { name: 'What you type' }), 'abc');

    expect(cryptoContent.generateKeyPair).toHaveBeenCalledTimes(1);
  });

  it('draws a fresh demo key for each mount', () => {
    const first = render(<EncryptionDemo initialSample={SAMPLE} />);
    first.unmount();
    render(<EncryptionDemo initialSample={SAMPLE} />);

    const keys = vi
      .mocked(cryptoContent.generateKeyPair)
      .mock.results.flatMap((result) => (result.type === 'return' ? [result.value.publicKey] : []));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toStrictEqual(keys[1]);
  });

  it('applies a caller class to its frame', () => {
    const { container } = render(<EncryptionDemo initialSample={SAMPLE} className="mt-12" />);

    expect(container.firstElementChild).toHaveClass('mt-12');
  });
});
