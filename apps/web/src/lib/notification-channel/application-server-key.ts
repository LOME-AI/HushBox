import { z } from 'zod';
import { fromBase64 } from '@hushbox/shared';

// Imported by the service worker as well as the app: it must stay free of the
// API client and anything else that would drag app code into the worker bundle.

/**
 * Registry-backed: `envConfig` supplies VITE_VAPID_PUBLIC_KEY for every mode
 * (and the build inlines it into the worker bundle), so a missing value is a
 * broken bootstrap that must fail fast rather than mint a subscription no
 * server can encrypt to.
 */
export function applicationServerKey(): Uint8Array<ArrayBuffer> {
  const key = z
    .string()
    .min(1)
    .parse(import.meta.env['VITE_VAPID_PUBLIC_KEY']);
  // Re-wrapped so the bytes sit alone on a plain ArrayBuffer: what
  // `PushManager.subscribe` accepts, and what the worker passes as the buffer.
  return new Uint8Array(fromBase64(key));
}

/**
 * Whether a subscription's `options.applicationServerKey` is the configured
 * key. A subscription outlives a keypair change and the push service then
 * rejects every send to it, so one made under another key — or one whose key
 * the browser does not report — is replaced rather than re-registered.
 */
export function matchesApplicationServerKey(
  existingKey: ArrayBuffer | null,
  key: Uint8Array
): boolean {
  if (existingKey === null) return false;
  const existing = new Uint8Array(existingKey);
  return existing.length === key.length && existing.every((byte, index) => byte === key[index]);
}
