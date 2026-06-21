import { describe, it, expect, beforeEach } from 'vitest';
import { useDecryptionActivityStore } from './decryption-activity.js';

describe('useDecryptionActivityStore', () => {
  beforeEach(() => {
    useDecryptionActivityStore.setState({ pendingDecryptions: 0 });
  });

  it('exposes the decryption counter API', () => {
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);

    useDecryptionActivityStore.getState().markPending();
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);

    useDecryptionActivityStore.getState().markComplete();
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
  });
});
