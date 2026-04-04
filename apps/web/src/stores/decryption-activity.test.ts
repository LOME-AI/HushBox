import { describe, it, expect, beforeEach } from 'vitest';
import { useDecryptionActivityStore } from './decryption-activity.js';

describe('useDecryptionActivityStore', () => {
  beforeEach(() => {
    useDecryptionActivityStore.setState({ pendingDecryptions: 0 });
  });

  it('starts with zero pending decryptions', () => {
    const state = useDecryptionActivityStore.getState();
    expect(state.pendingDecryptions).toBe(0);
  });

  it('increments pending decryptions on markPending', () => {
    useDecryptionActivityStore.getState().markPending();

    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);
  });

  it('decrements pending decryptions on markComplete', () => {
    useDecryptionActivityStore.getState().markPending();
    useDecryptionActivityStore.getState().markComplete();

    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
  });

  it('tracks multiple concurrent pending decryptions', () => {
    useDecryptionActivityStore.getState().markPending();
    useDecryptionActivityStore.getState().markPending();

    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(2);

    useDecryptionActivityStore.getState().markComplete();

    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);
  });

  it('never goes below zero', () => {
    useDecryptionActivityStore.getState().markComplete();

    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
  });
});
