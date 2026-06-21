/**
 * Seeds a fake "demo user" session directly into the auth store — no OPAQUE
 * login. Generating one account keypair and seeding `privateKey` lets the real
 * decrypt path run; returning the public key lets the fake backend encrypt
 * fixtures to the SAME account so they decrypt.
 *
 * Storage is left untouched on purpose: `getStoredAuth()` returns null, so the
 * app's `doInitAuth()` early-returns without ever calling `GET /api/auth/me`,
 * and nothing clobbers the seeded session. The private key lives in memory
 * only — same security posture as a real login.
 */
import { generateKeyPair } from '@hushbox/crypto';
import { useAuthStore } from '@/lib/auth';
import { DEMO_USER } from './mock-backend/fixtures';

export interface DemoSession {
  readonly accountPublicKey: Uint8Array;
  readonly accountPrivateKey: Uint8Array;
}

export function seedDemoSession(): DemoSession {
  const { publicKey, privateKey } = generateKeyPair();
  const store = useAuthStore.getState();
  store.setUser({
    id: DEMO_USER.id,
    email: DEMO_USER.email,
    username: DEMO_USER.username,
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
  });
  store.setPrivateKey(privateKey);
  store.setLoading(false);
  return { accountPublicKey: publicKey, accountPrivateKey: privateKey };
}
