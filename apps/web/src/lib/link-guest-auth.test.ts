import { describe, it, expect, beforeEach } from 'vitest';
import { setLinkGuestAuth, getLinkGuestAuth, clearLinkGuestAuth } from './link-guest-auth';

describe('link-guest-auth', () => {
  beforeEach(() => {
    clearLinkGuestAuth();
  });

  it('returns null when no key is set', () => {
    expect(getLinkGuestAuth()).toBeNull();
  });

  it('returns the key after setting it', () => {
    setLinkGuestAuth('test-public-key');
    expect(getLinkGuestAuth()).toBe('test-public-key');
  });

  it('overwrites the key when set again', () => {
    setLinkGuestAuth('key-1');
    setLinkGuestAuth('key-2');
    expect(getLinkGuestAuth()).toBe('key-2');
  });

  it('returns null after clearing', () => {
    setLinkGuestAuth('test-public-key');
    clearLinkGuestAuth();
    expect(getLinkGuestAuth()).toBeNull();
  });

  it('is safe to clear when already null', () => {
    clearLinkGuestAuth();
    expect(getLinkGuestAuth()).toBeNull();
  });
});
