/**
 * Module-level cache for decrypted epoch private keys.
 * Key format: "conversationId:epochNumber" -> epoch private key (Uint8Array)
 *
 * ECIES unwrap is deterministic so caching is safe.
 * clearEpochKeyCache() zeros all keys before clearing — call on logout.
 *
 * Supports React integration via useSyncExternalStore(subscribe, getSnapshot).
 * Components that depend on epoch keys re-render when setEpochKey is called.
 *
 * processKeyChain() is the shared entry point for populating the cache from
 * a fetched key chain response. Used by useDecryptedMessages and
 * useDecryptedConversations.
 */

import { unwrapEpochKey, traverseChainLink, verifyEpochKeyConfirmation } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';

const cache = new Map<string, Uint8Array>();
const currentEpochMap = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

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
  for (const listener of listeners) listener();
}

export function getCurrentEpoch(conversationId: string): number | undefined {
  return currentEpochMap.get(conversationId);
}

export function setCurrentEpoch(conversationId: string, epochNumber: number): void {
  if (currentEpochMap.get(conversationId) === epochNumber) return;
  currentEpochMap.set(conversationId, epochNumber);
  version++;
  for (const listener of listeners) listener();
}

export function clearEpochKeyCache(): void {
  for (const key of cache.values()) {
    key.fill(0);
  }
  cache.clear();
  currentEpochMap.clear();
  version++;
  for (const listener of listeners) listener();
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

export interface KeyChainWrap {
  epochNumber: number;
  wrap: string;
  confirmationHash: string;
  visibleFromEpoch: number;
}

export interface KeyChainLink {
  epochNumber: number;
  chainLink: string;
  confirmationHash: string;
}

export interface KeyChainResponse {
  wraps: KeyChainWrap[];
  chainLinks: KeyChainLink[];
  currentEpoch: number;
}

function tryUnwrapKey(accountPrivateKey: Uint8Array, wrap: KeyChainWrap): Uint8Array | undefined {
  try {
    const epochPrivKey = unwrapEpochKey(accountPrivateKey, fromBase64(wrap.wrap));
    if (!verifyEpochKeyConfirmation(epochPrivKey, fromBase64(wrap.confirmationHash))) {
      return undefined;
    }
    return epochPrivKey;
  } catch {
    return undefined;
  }
}

function tryTraverseLink(newerKey: Uint8Array, link: KeyChainLink): Uint8Array | undefined {
  try {
    const olderKey = traverseChainLink(newerKey, fromBase64(link.chainLink));
    if (!verifyEpochKeyConfirmation(olderKey, fromBase64(link.confirmationHash))) {
      return undefined;
    }
    return olderKey;
  } catch {
    return undefined;
  }
}

function unwrapDirectKeys(
  conversationId: string,
  wraps: KeyChainWrap[],
  accountPrivateKey: Uint8Array
): void {
  const sorted = wraps.toSorted((a, b) => b.epochNumber - a.epochNumber);
  for (const wrap of sorted) {
    if (getEpochKey(conversationId, wrap.epochNumber)) continue;
    const key = tryUnwrapKey(accountPrivateKey, wrap);
    if (key) setEpochKey(conversationId, wrap.epochNumber, key);
  }
}

function resolveChainLinks(conversationId: string, chainLinks: KeyChainLink[]): void {
  const sorted = chainLinks.toSorted((a, b) => b.epochNumber - a.epochNumber);
  for (const cl of sorted) {
    const olderEpochNumber = cl.epochNumber - 1;
    if (getEpochKey(conversationId, olderEpochNumber)) continue;
    const newerKey = getEpochKey(conversationId, cl.epochNumber);
    if (!newerKey) continue;
    const key = tryTraverseLink(newerKey, cl);
    if (key) setEpochKey(conversationId, olderEpochNumber, key);
  }
}

/**
 * Processes a key chain response and populates the epoch key cache.
 * Unwraps direct epoch keys and resolves chain links for older epochs.
 * Shared between useDecryptedMessages and useDecryptedConversations.
 */
export function processKeyChain(
  conversationId: string,
  keyChain: KeyChainResponse,
  accountPrivateKey: Uint8Array
): void {
  setCurrentEpoch(conversationId, keyChain.currentEpoch);
  unwrapDirectKeys(conversationId, keyChain.wraps, accountPrivateKey);
  resolveChainLinks(conversationId, keyChain.chainLinks);
}
