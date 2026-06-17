import { describe, it, expect, beforeEach } from 'vitest';
import { getPublicKeyFromPrivate, decryptTextFromEpoch } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { useAuthStore } from '@/lib/auth';
import { processKeyChain, getEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import { seedDemoSession } from './seed-session';
import { DemoBackendStore } from './mock-backend/store';
import { DEMO_USER, DEMO_CONVERSATIONS } from './mock-backend/fixtures';

describe('seedDemoSession', () => {
  beforeEach(() => {
    clearEpochKeyCache();
    useAuthStore.getState().clear();
  });

  it('marks the auth store authenticated as the demo user with a private key', () => {
    const { accountPublicKey, accountPrivateKey } = seedDemoSession();
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.user?.id).toBe(DEMO_USER.id);
    expect(state.privateKey).toEqual(accountPrivateKey);
    expect(getPublicKeyFromPrivate(accountPrivateKey)).toEqual(accountPublicKey);
  });

  it('seeded private key decrypts a store built for the seeded account', () => {
    const { accountPublicKey, accountPrivateKey } = seedDemoSession();
    const store = new DemoBackendStore(accountPublicKey);
    const fixture = DEMO_CONVERSATIONS[0];
    if (fixture === undefined) throw new Error('no fixtures');

    const keyChain = store.getKeyChain(fixture.id);
    if (keyChain === undefined) throw new Error('no keychain');
    processKeyChain(fixture.id, keyChain, accountPrivateKey);

    const item = store.listConversations().conversations.find((c) => c.id === fixture.id);
    if (item === undefined) throw new Error('no list item');
    const epochKey = getEpochKey(fixture.id, item.titleEpochNumber);
    if (epochKey === undefined) throw new Error('no epoch key');
    expect(decryptTextFromEpoch(epochKey, fromBase64(item.title))).toBe(fixture.title);
  });

  it('does not write any account material to storage (key stays in memory only)', () => {
    seedDemoSession();
    expect(localStorage.getItem('hushbox_auth_kek')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
