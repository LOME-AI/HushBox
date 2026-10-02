import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';

// Force the encryption seam to fail so the component's graceful-degradation
// branch (the `catch` that renders "(encryption unavailable)") is exercised.
// Crypto is a true external seam here, not an internal slice barrel.
vi.mock('@hushbox/crypto/content', () => ({
  generateKeyPair: (): { publicKey: Uint8Array } => ({ publicKey: new Uint8Array(32) }),
  encryptTextForEpoch: (): never => {
    throw new Error('crypto unavailable');
  },
}));

import { EncryptionDemo } from './encryption-demo';
import type { DemoSample } from '../lib/encryption-demo-sample';

const BUILD_TIME_SAMPLE: DemoSample = { hex: 'ab'.repeat(90), byteLength: 90 };

describe('EncryptionDemo encryption failure fallback', () => {
  it('renders an "(encryption unavailable)" placeholder when encryption throws', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo initialSample={BUILD_TIME_SAMPLE} />);

    await user.type(screen.getByRole('textbox', { name: 'What you type' }), '!');

    expect(screen.getByTestId(TEST_IDS.cipherOutput)).toHaveTextContent('(encryption unavailable)');
  });

  it('counts no bytes when encryption throws', async () => {
    const user = userEvent.setup();
    render(<EncryptionDemo initialSample={BUILD_TIME_SAMPLE} />);

    await user.type(screen.getByRole('textbox', { name: 'What you type' }), '!');

    expect(screen.queryByText(/\bbytes$/)).toBeNull();
  });
});
