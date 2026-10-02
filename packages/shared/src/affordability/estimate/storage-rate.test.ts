import { describe, expect, it } from 'vitest';

import {
  charStorageNanoUsd,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  mediaStorageNanoUsd,
  STORAGE_COST_PER_CHARACTER_NANO,
} from './storage-rate.ts';

describe('STORAGE_COST_PER_CHARACTER_NANO', () => {
  it('is the $0.0000003/char storage rate in nano-USD', () => {
    expect(STORAGE_COST_PER_CHARACTER_NANO).toBe(300n);
  });
});

describe('MEDIA_STORAGE_COST_PER_BYTE_NANO', () => {
  it('is the $0.000000018/byte media storage rate in nano-USD', () => {
    expect(MEDIA_STORAGE_COST_PER_BYTE_NANO).toBe(18n);
  });
});

describe('charStorageNanoUsd', () => {
  it('prices 1000 characters at 300_000 nano-USD', () => {
    expect(charStorageNanoUsd(1000)).toBe(300_000n);
  });

  it('prices a single character at the per-character rate', () => {
    expect(charStorageNanoUsd(1)).toBe(300n);
  });

  it('prices nothing stored at zero', () => {
    expect(charStorageNanoUsd(0)).toBe(0n);
  });
});

describe('mediaStorageNanoUsd', () => {
  it('prices one megabyte at 18_000_000 nano-USD', () => {
    expect(mediaStorageNanoUsd(1_000_000)).toBe(18_000_000n);
  });

  it('prices a single byte at the per-byte rate', () => {
    expect(mediaStorageNanoUsd(1)).toBe(18n);
  });

  it('prices nothing stored at zero', () => {
    expect(mediaStorageNanoUsd(0)).toBe(0n);
  });
});
