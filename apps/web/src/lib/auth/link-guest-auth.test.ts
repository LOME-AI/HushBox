import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  setLinkGuestAuth,
  getLinkGuestAuth,
  clearLinkGuestAuth,
  isLinkGuestActive,
  subscribeLinkGuestAuth,
  useLinkGuestActive,
} from './link-guest-auth';

describe('link-guest-auth', () => {
  beforeEach(() => {
    clearLinkGuestAuth();
  });

  it('returns null when no token is set', () => {
    expect(getLinkGuestAuth()).toBeNull();
  });

  it('returns the token after setting it', () => {
    setLinkGuestAuth('test-auth-token');
    expect(getLinkGuestAuth()).toBe('test-auth-token');
  });

  it('overwrites the token when set again', () => {
    setLinkGuestAuth('token-1');
    setLinkGuestAuth('token-2');
    expect(getLinkGuestAuth()).toBe('token-2');
  });

  it('returns null after clearing', () => {
    setLinkGuestAuth('test-auth-token');
    clearLinkGuestAuth();
    expect(getLinkGuestAuth()).toBeNull();
  });

  it('is safe to clear when already null', () => {
    clearLinkGuestAuth();
    expect(getLinkGuestAuth()).toBeNull();
  });
});

describe('link-guest mode', () => {
  beforeEach(() => {
    clearLinkGuestAuth();
  });

  it('is inactive when no token is set', () => {
    expect(isLinkGuestActive()).toBe(false);
  });

  it('is active once a token is set', () => {
    setLinkGuestAuth('test-auth-token');
    expect(isLinkGuestActive()).toBe(true);
  });

  it('is inactive again after clearing', () => {
    setLinkGuestAuth('test-auth-token');
    clearLinkGuestAuth();
    expect(isLinkGuestActive()).toBe(false);
  });

  it('notifies subscribers when the mode is entered', () => {
    const listener = vi.fn();
    subscribeLinkGuestAuth(listener);

    setLinkGuestAuth('test-auth-token');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when the mode is left', () => {
    setLinkGuestAuth('test-auth-token');
    const listener = vi.fn();
    subscribeLinkGuestAuth(listener);

    clearLinkGuestAuth();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a subscriber that unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLinkGuestAuth(listener);
    unsubscribe();

    setLinkGuestAuth('test-auth-token');

    expect(listener).not.toHaveBeenCalled();
  });

  it('re-renders a consuming component when the mode is entered', () => {
    const { result } = renderHook(() => useLinkGuestActive());
    expect(result.current).toBe(false);

    act(() => {
      setLinkGuestAuth('test-auth-token');
    });

    expect(result.current).toBe(true);
  });

  it('re-renders a consuming component when the mode is left', () => {
    setLinkGuestAuth('test-auth-token');
    const { result } = renderHook(() => useLinkGuestActive());
    expect(result.current).toBe(true);

    act(() => {
      clearLinkGuestAuth();
    });

    expect(result.current).toBe(false);
  });
});
