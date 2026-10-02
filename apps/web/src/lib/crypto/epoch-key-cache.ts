/**
 * Module-level cache for decrypted epoch private keys.
 * Key format: "conversationId:epochNumber" -> epoch private key (Uint8Array)
 *
 * ECIES unwrap is deterministic so caching is safe.
 * clearEpochKeyCache() zeros all keys before clearing — call on logout.
 *
 * Supports React integration via useSyncExternalStore(subscribe, getSnapshot).
 * Components that depend on epoch keys or on a conversation's verdict
 * re-render when either changes.
 *
 * processKeyChain() is the shared entry point for populating the cache from
 * a fetched key chain response: it verifies the chain, caches only verified
 * keys, and records the conversation's verdict. Used by useDecryptedMessages
 * and useDecryptedConversations.
 */

import { verifyKeyChain } from '@hushbox/crypto';
import type { KeyChainResponse } from '@hushbox/shared';

const cache = new Map<string, Uint8Array>();
const currentEpochMap = new Map<string, number>();
const verdictMap = new Map<string, EpochVerdict>();
const listeners = new Set<() => void>();
let version = 0;
let notificationPending = false;

/**
 * Defer listener notifications to the next microtask.
 *
 * processKeyChain() is called inside React useMemo (during render) so that
 * decrypted keys are available in the same render pass. Synchronous listener
 * calls would trigger useSyncExternalStore subscribers (other components) to
 * re-render mid-render, causing React's "Cannot update a component while
 * rendering a different component" error.
 *
 * queueMicrotask runs after the current synchronous call stack but before
 * the browser paints, so dependent components re-render in the same frame
 * with no visual flash.
 */
function scheduleNotification(): void {
  if (notificationPending) return;
  notificationPending = true;
  queueMicrotask(() => {
    notificationPending = false;
    for (const listener of listeners) listener();
  });
}

function buildKey(conversationId: string, epochNumber: number): string {
  return `${conversationId}:${String(epochNumber)}`;
}

export function getEpochKey(conversationId: string, epochNumber: number): Uint8Array | undefined {
  return cache.get(buildKey(conversationId, epochNumber));
}

export function setEpochKey(conversationId: string, epochNumber: number, key: Uint8Array): void {
  if (cache.has(buildKey(conversationId, epochNumber))) return;
  cache.set(buildKey(conversationId, epochNumber), key);
  version++;
  scheduleNotification();
}

export function getCurrentEpoch(conversationId: string): number | undefined {
  return currentEpochMap.get(conversationId);
}

export function setCurrentEpoch(conversationId: string, epochNumber: number): void {
  const current = currentEpochMap.get(conversationId);
  if (current !== undefined && current >= epochNumber) return;
  currentEpochMap.set(conversationId, epochNumber);
  version++;
  scheduleNotification();
}

export function clearEpochKeyCache(): void {
  for (const key of cache.values()) {
    key.fill(0);
  }
  cache.clear();
  currentEpochMap.clear();
  verdictMap.clear();
  version++;
  scheduleNotification();
}

export function getCacheSize(): number {
  return cache.size;
}

/** Subscribe to cache changes. For use with React's useSyncExternalStore. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Get the current cache version. For use with React's useSyncExternalStore. */
export function getSnapshot(): number {
  return version;
}

/**
 * What this client's verification of a conversation's keychain concluded, for
 * the surfaces that must refuse to encrypt, repair a rotation, or mark content
 * written under keys that did not verify.
 */
export interface EpochVerdict {
  readonly currentEpoch: number;
  /** The server's word that the current epoch still holds a departed seat's wrap. */
  readonly rotationPending: boolean;
  /** `bad` when the current epoch's key, or a chain link on its path down, failed verification. */
  readonly rotation: 'ok' | 'bad';
  /** The newest epoch a recovery rotation may chain from; null when none verified. */
  readonly lastGoodEpoch: number | null;
  /** Epochs whose own key failed verification: content under them was written under invalid keys. */
  readonly badEpochs: ReadonlySet<number>;
}

export function getEpochVerdict(conversationId: string): EpochVerdict | undefined {
  return verdictMap.get(conversationId);
}

/**
 * A keychain for an older epoch than the one already judged is a stale read
 * (a batch fetched before a rotation), so it never replaces the newer verdict.
 */
function setEpochVerdict(conversationId: string, verdict: EpochVerdict): void {
  const current = verdictMap.get(conversationId);
  if (current !== undefined && current.currentEpoch > verdict.currentEpoch) return;
  verdictMap.set(conversationId, verdict);
  version++;
  scheduleNotification();
}

/**
 * Verifies a fetched keychain and caches every key whose own verdict is ok. A
 * key that failed verification is never cached, so every reader of this cache
 * — decryption, and every rotation built from `getEpochKey` — sees verified
 * keys only.
 */
export function processKeyChain(
  conversationId: string,
  keyChain: KeyChainResponse,
  principalPrivateKey: Uint8Array
): void {
  const verdict = verifyKeyChain(keyChain, principalPrivateKey, conversationId);
  for (const [epochNumber, key] of verdict.keys) setEpochKey(conversationId, epochNumber, key);
  setCurrentEpoch(conversationId, keyChain.currentEpoch);
  const badEpochs = new Set<number>();
  for (const [epochNumber, epoch] of verdict.epochs) {
    if (epoch.key.status === 'bad') badEpochs.add(epochNumber);
  }
  setEpochVerdict(conversationId, {
    currentEpoch: keyChain.currentEpoch,
    rotationPending: keyChain.rotationPending,
    rotation: verdict.rotation,
    lastGoodEpoch: verdict.lastGoodEpoch,
    badEpochs,
  });
}

export { type KeyChainResponse } from '@hushbox/shared';
