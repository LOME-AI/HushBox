import { describe, expect, it } from 'vitest';

import { MEDIA_RUN_STORAGE_BOUND_BYTES, mediaRunStorageNanoUsd } from './output-bytes.ts';
import { VALUE_STORE_BYTE_BUDGET_BYTES } from '../../constants.ts';

describe('MEDIA_RUN_STORAGE_BOUND_BYTES', () => {
  it('is the byte budget the run value store admits', () => {
    expect(MEDIA_RUN_STORAGE_BOUND_BYTES).toBe(VALUE_STORE_BYTE_BUDGET_BYTES);
  });
});

describe('mediaRunStorageNanoUsd', () => {
  it('prices the run bound at the media byte rate: 20,971,520 bytes × 18', () => {
    expect(mediaRunStorageNanoUsd()).toBe(377_487_360n);
  });
});
