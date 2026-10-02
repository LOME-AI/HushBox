/**
 * Per-message decrypted-content cache, keyed by `conversationId:messageId`.
 *
 * Realtime invalidation (use-realtime-sync) refetches the conversation on
 * every inbound event, producing a fresh `messages` array reference each
 * time. Without this cache the decrypt hook would re-decrypt the entire
 * history synchronously on the main thread per event. The cache lets unchanged
 * messages reuse their plaintext so only NEW or epoch-rotated messages
 * decrypt.
 *
 * `epochNumber` is stored alongside the plaintext: a message that rotates to
 * a new epoch must re-decrypt (its content key is now sealed under a
 * different epoch key), so a stale-epoch hit is treated as a miss.
 *
 * This holds decrypted PLAINTEXT at module scope. It lives in its own leaf
 * module (imported by both the decrypt hook and auth teardown) so that
 * `clearLocalAuthState` can drop it on sign-out without a module import cycle.
 */
export interface DecryptedEntry {
  epochNumber: number;
  content: string;
}

/**
 * Capacity in entries, one entry being one message's plaintext.
 *
 * The client loads a conversation's history to exhaustion and the decrypt hook
 * maps every message of it, so the fill is one entry per message per
 * conversation opened. The bound has to clear the longest conversation anyone
 * holds open: a conversation larger than the capacity evicts its own entries
 * while decrypting, and every realtime invalidation then re-decrypts the whole
 * history, which is the cost this cache exists to avoid. A thousand messages is
 * far past that mark and still leaves room for the several conversations a user
 * moves between, while levelling retained plaintext off at a few megabytes
 * rather than growing it with session length.
 */
export const DECRYPTED_CACHE_CAPACITY = 1000;

/**
 * Least-recently-used bound. A read counts as use, so the conversation on
 * screen stays resident (every message of it is read on each recompute) while
 * the conversations behind it age out.
 */
class BoundedDecryptedCache extends Map<string, DecryptedEntry> {
  override get(cacheKey: string): DecryptedEntry | undefined {
    const entry = super.get(cacheKey);
    if (entry === undefined) return undefined;
    super.delete(cacheKey);
    super.set(cacheKey, entry);
    return entry;
  }

  override set(cacheKey: string, entry: DecryptedEntry): this {
    super.delete(cacheKey);
    super.set(cacheKey, entry);
    for (const lruKey of super.keys()) {
      if (this.size <= DECRYPTED_CACHE_CAPACITY) break;
      super.delete(lruKey);
    }
    return this;
  }
}

export const decryptedCache: Map<string, DecryptedEntry> = new BoundedDecryptedCache();

export function decryptedCacheKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

/** Clears the per-message decrypted-content cache. */
export function clearDecryptedMessageCache(): void {
  decryptedCache.clear();
}
