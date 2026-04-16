import { describe, it, expect, beforeEach } from 'vitest';
import { createMockMediaStorage } from './mock.js';
import type { MockMediaStorage } from './types.js';
import { StorageReadError } from './types.js';

describe('createMockMediaStorage', () => {
  let storage: MockMediaStorage;

  beforeEach(() => {
    storage = createMockMediaStorage();
  });

  describe('factory', () => {
    it('returns a storage with isMock set to true', () => {
      expect(storage.isMock).toBe(true);
    });

    it('exposes all MediaStorage methods', () => {
      expect(typeof storage.put).toBe('function');
      expect(typeof storage.mintDownloadUrl).toBe('function');
      expect(typeof storage.delete).toBe('function');
    });

    it('exposes test helpers', () => {
      expect(typeof storage.getObject).toBe('function');
      expect(typeof storage.clearAll).toBe('function');
      expect(typeof storage.listKeys).toBe('function');
    });

    it('starts empty', () => {
      expect(storage.listKeys()).toEqual([]);
    });
  });

  describe('put', () => {
    it('stores bytes under the given key', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await storage.put('media/conv/msg/item.enc', bytes, 'application/octet-stream');
      const stored = storage.getObject('media/conv/msg/item.enc');
      expect(stored).toBeDefined();
      expect(stored!.bytes).toEqual(bytes);
      expect(stored!.contentType).toBe('application/octet-stream');
    });

    it('overwrites an existing key', async () => {
      await storage.put('k', new Uint8Array([1]), 'application/octet-stream');
      await storage.put('k', new Uint8Array([2, 3]), 'application/octet-stream');
      const stored = storage.getObject('k');
      expect(stored!.bytes).toEqual(new Uint8Array([2, 3]));
    });

    it('tracks keys in insertion order', async () => {
      await storage.put('a', new Uint8Array([1]), 'application/octet-stream');
      await storage.put('b', new Uint8Array([2]), 'application/octet-stream');
      await storage.put('c', new Uint8Array([3]), 'application/octet-stream');
      expect(storage.listKeys()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('mintDownloadUrl', () => {
    it('returns a data URL with the stored bytes base64-encoded', async () => {
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await storage.put('k', bytes, 'application/octet-stream');
      const { url } = await storage.mintDownloadUrl({ key: 'k' });
      expect(url.startsWith('data:application/octet-stream;base64,')).toBe(true);
    });

    it('returns an ISO-8601 expiresAt timestamp', async () => {
      await storage.put('k', new Uint8Array([1]), 'application/octet-stream');
      const { expiresAt } = await storage.mintDownloadUrl({ key: 'k' });
      expect(new Date(expiresAt).toString()).not.toBe('Invalid Date');
    });

    it('honors expiresInSec when provided', async () => {
      await storage.put('k', new Uint8Array([1]), 'application/octet-stream');
      const before = Date.now();
      const { expiresAt } = await storage.mintDownloadUrl({ key: 'k', expiresInSec: 60 });
      const after = Date.now();
      const expiryMs = new Date(expiresAt).getTime();
      // Within a small tolerance, expiry should be ~60s from now
      expect(expiryMs).toBeGreaterThanOrEqual(before + 60_000);
      expect(expiryMs).toBeLessThanOrEqual(after + 60_000 + 1000);
    });

    it('uses the default TTL when expiresInSec is omitted', async () => {
      await storage.put('k', new Uint8Array([1]), 'application/octet-stream');
      const before = Date.now();
      const { expiresAt } = await storage.mintDownloadUrl({ key: 'k' });
      const expiryMs = new Date(expiresAt).getTime();
      // Default TTL is MEDIA_DOWNLOAD_URL_TTL_SECONDS = 300
      expect(expiryMs - before).toBeGreaterThan(1000);
    });

    it('throws StorageReadError for a missing key', async () => {
      await expect(storage.mintDownloadUrl({ key: 'does-not-exist' })).rejects.toBeInstanceOf(
        StorageReadError
      );
    });

    it('recovers original bytes from the data URL', async () => {
      const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x7f]);
      await storage.put('k', bytes, 'application/octet-stream');
      const { url } = await storage.mintDownloadUrl({ key: 'k' });
      const base64 = url.split(',')[1] ?? '';
      const decoded = Uint8Array.from(atob(base64), (c) => c.codePointAt(0) ?? 0);
      expect(decoded).toEqual(bytes);
    });
  });

  describe('delete', () => {
    it('removes a stored key', async () => {
      await storage.put('k', new Uint8Array([1]), 'application/octet-stream');
      await storage.delete('k');
      expect(storage.getObject('k')).toBeUndefined();
      expect(storage.listKeys()).toEqual([]);
    });

    it('is idempotent for missing keys', async () => {
      await expect(storage.delete('never-existed')).resolves.toBeUndefined();
    });

    it('does not affect other keys', async () => {
      await storage.put('a', new Uint8Array([1]), 'application/octet-stream');
      await storage.put('b', new Uint8Array([2]), 'application/octet-stream');
      await storage.delete('a');
      expect(storage.listKeys()).toEqual(['b']);
    });
  });

  describe('clearAll', () => {
    it('removes all stored objects', async () => {
      await storage.put('a', new Uint8Array([1]), 'application/octet-stream');
      await storage.put('b', new Uint8Array([2]), 'application/octet-stream');
      storage.clearAll();
      expect(storage.listKeys()).toEqual([]);
    });
  });
});
