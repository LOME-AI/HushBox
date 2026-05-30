import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTrackedDecryption } from './use-tracked-decryption';
import { useDecryptionActivityStore } from '@/stores/decryption-activity';

describe('useTrackedDecryption', () => {
  beforeEach(() => {
    useDecryptionActivityStore.setState({ pendingDecryptions: 0 });
  });

  it('does not bump the counter when isPending is false', () => {
    renderHook(() => {
      useTrackedDecryption(false);
    });
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
  });

  it('bumps the counter while isPending is true and clears on unmount', () => {
    const { unmount } = renderHook(() => {
      useTrackedDecryption(true);
    });
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);
    unmount();
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
  });

  it('transitions correctly when isPending flips false', () => {
    const { rerender } = renderHook(
      ({ pending }: { pending: boolean }) => {
        useTrackedDecryption(pending);
      },
      {
        initialProps: { pending: true },
      }
    );
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);
    rerender({ pending: false });
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
  });

  it('two simultaneous mounts both contribute and clear independently', () => {
    const { unmount: unmountA } = renderHook(() => {
      useTrackedDecryption(true);
    });
    const { unmount: unmountB } = renderHook(() => {
      useTrackedDecryption(true);
    });
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(2);
    unmountA();
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);
    unmountB();
    expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
  });
});
