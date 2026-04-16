import { MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { StorageReadError, type MockMediaStorage } from './types.js';

/**
 * In-memory MediaStorage for tests and local dev when MinIO is not running.
 *
 * - `put` / `delete` manipulate an internal Map.
 * - `mintDownloadUrl` returns a `data:` URL encoding the stored bytes, so
 *   a client `fetch(url)` yields the exact ciphertext without network I/O.
 */
export function createMockMediaStorage(): MockMediaStorage {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();

  return {
    isMock: true,

    put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      // Copy the caller's buffer so later mutations don't leak in.
      store.set(key, { bytes: new Uint8Array(bytes), contentType });
      return Promise.resolve();
    },

    mintDownloadUrl(params: {
      key: string;
      expiresInSec?: number;
    }): Promise<{ url: string; expiresAt: string }> {
      const entry = store.get(params.key);
      if (!entry) {
        return Promise.reject(new StorageReadError(`Media object not found: ${params.key}`));
      }
      const base64 = bytesToBase64(entry.bytes);
      const url = `data:${entry.contentType};base64,${base64}`;
      const ttl = params.expiresInSec ?? MEDIA_DOWNLOAD_URL_TTL_SECONDS;
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      return Promise.resolve({ url, expiresAt });
    },

    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },

    getObject(key: string): { bytes: Uint8Array; contentType: string } | undefined {
      return store.get(key);
    },

    clearAll(): void {
      store.clear();
    },

    listKeys(): string[] {
      return [...store.keys()];
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}
