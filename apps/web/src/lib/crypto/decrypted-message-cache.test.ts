import { describe, it, expect, beforeEach } from 'vitest';
import {
  DECRYPTED_CACHE_CAPACITY,
  clearDecryptedMessageCache,
  decryptedCache,
  decryptedCacheKey,
  type DecryptedEntry,
} from './decrypted-message-cache';

function entry(content: string): DecryptedEntry {
  return { epochNumber: 1, content };
}

function key(index: number): string {
  return decryptedCacheKey('conv', `msg-${String(index)}`);
}

function fillToCapacity(): void {
  for (let index = 0; index < DECRYPTED_CACHE_CAPACITY; index += 1) {
    decryptedCache.set(key(index), entry(`plaintext-${String(index)}`));
  }
}

describe('decryptedCache', () => {
  beforeEach(() => {
    clearDecryptedMessageCache();
  });

  it('holds at most its capacity however many entries are inserted', () => {
    for (let index = 0; index < DECRYPTED_CACHE_CAPACITY * 2 + 7; index += 1) {
      decryptedCache.set(key(index), entry(`plaintext-${String(index)}`));
    }

    expect(decryptedCache.size).toBe(DECRYPTED_CACHE_CAPACITY);
  });

  it('keeps the most recently inserted entries when insertions pass capacity', () => {
    const overflow = 5;

    for (let index = 0; index < DECRYPTED_CACHE_CAPACITY + overflow; index += 1) {
      decryptedCache.set(key(index), entry(`plaintext-${String(index)}`));
    }

    expect(decryptedCache.has(key(overflow - 1))).toBe(false);
    expect(decryptedCache.has(key(overflow))).toBe(true);
    expect(decryptedCache.has(key(DECRYPTED_CACHE_CAPACITY + overflow - 1))).toBe(true);
  });

  it('evicts the least recently inserted entry first', () => {
    fillToCapacity();

    decryptedCache.set(key(DECRYPTED_CACHE_CAPACITY), entry('newest'));

    expect(decryptedCache.has(key(0))).toBe(false);
    expect(decryptedCache.has(key(1))).toBe(true);
  });

  it('spares an entry that was read since it was written', () => {
    fillToCapacity();

    decryptedCache.get(key(0));
    decryptedCache.set(key(DECRYPTED_CACHE_CAPACITY), entry('newest'));

    expect(decryptedCache.has(key(0))).toBe(true);
    expect(decryptedCache.has(key(1))).toBe(false);
  });

  it('spares an entry that was rewritten since it was first written', () => {
    fillToCapacity();

    decryptedCache.set(key(0), entry('rewritten'));
    decryptedCache.set(key(DECRYPTED_CACHE_CAPACITY), entry('newest'));

    expect(decryptedCache.get(key(0))?.content).toBe('rewritten');
    expect(decryptedCache.has(key(1))).toBe(false);
  });

  it('does not grow when an existing key is rewritten', () => {
    decryptedCache.set(key(0), entry('first'));

    decryptedCache.set(key(0), entry('second'));

    expect(decryptedCache.size).toBe(1);
  });

  it('returns undefined for a key it never held', () => {
    expect(decryptedCache.get(key(0))).toBeUndefined();
  });

  it('reads back an entry it was given', () => {
    decryptedCache.set(key(0), entry('plaintext'));

    expect(decryptedCache.get(key(0))).toEqual({ epochNumber: 1, content: 'plaintext' });
  });

  it('drops every entry when cleared', () => {
    fillToCapacity();

    clearDecryptedMessageCache();

    expect(decryptedCache.size).toBe(0);
  });
});
