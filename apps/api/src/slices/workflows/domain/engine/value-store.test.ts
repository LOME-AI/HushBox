import { describe, expect, it } from 'vitest';
import { MAX_SELECTED_MODELS, VALUE_STORE_BYTE_BUDGET_BYTES } from '@hushbox/shared';
import { createValueStore, measureValueBytes } from './value-store.js';

describe('measureValueBytes', () => {
  it('meters text at two bytes per UTF-16 code unit', () => {
    expect(measureValueBytes('abcd')).toBe(8);
  });

  it('meters absent values as zero', () => {
    expect(measureValueBytes()).toBe(0);
  });

  it('meters null as zero', () => {
    expect(measureValueBytes(null)).toBe(0);
  });

  it('meters raw bytes at their byte length', () => {
    expect(measureValueBytes(new Uint8Array(16))).toBe(16);
  });

  it('meters a list as the sum of its elements', () => {
    expect(measureValueBytes(['ab', 'cd'])).toBe(8);
  });

  it('meters a text content value by its inline text', () => {
    expect(measureValueBytes({ kind: 'text', text: 'abc' })).toBe(6);
  });

  it('meters a bytes content value by its payload length', () => {
    expect(
      measureValueBytes({
        kind: 'bytes',
        bytes: new Uint8Array(32),
        mimeType: 'image/png',
        modality: 'image',
      })
    ).toBe(32);
  });

  it('meters a media content value by its declared byte length', () => {
    expect(
      measureValueBytes({
        kind: 'media',
        value: {
          ref: 'media/c/m/u',
          mimeType: 'image/png',
          modality: 'image',
          byteLength: 1024,
          metadata: {},
        },
      })
    ).toBe(1024);
  });

  it('meters a bare media value object by its declared byte length', () => {
    expect(
      measureValueBytes({
        ref: 'media/c/m/u',
        mimeType: 'image/png',
        modality: 'image',
        byteLength: 512,
        metadata: {},
      })
    ).toBe(512);
  });

  it('meters a malformed media envelope by its serialized size', () => {
    // {"kind":"media","value":{}} is 27 characters.
    expect(measureValueBytes({ kind: 'media', value: {} })).toBe(54);
  });

  it('meters bigint object fields by their decimal rendering', () => {
    // {"n":"12345"} is 13 characters.
    expect(measureValueBytes({ n: 12_345n })).toBe(26);
  });

  it('meters a json object by its serialized size', () => {
    // {"label":"x"} is 13 characters.
    expect(measureValueBytes({ label: 'x' })).toBe(26);
  });

  it('meters primitives by their decimal rendering', () => {
    expect(measureValueBytes(1234n)).toBe(8);
  });

  it('meters numbers by their decimal rendering', () => {
    expect(measureValueBytes(123)).toBe(6);
  });

  it('meters booleans by their literal rendering', () => {
    expect(measureValueBytes(true)).toBe(8);
  });

  it('meters unrepresentable channel values as zero', () => {
    expect(measureValueBytes(Symbol('never'))).toBe(0);
  });
});

describe('createValueStore', () => {
  it('defaults the budget to the documented twenty-megabyte ceiling', () => {
    expect(VALUE_STORE_BYTE_BUDGET_BYTES).toBe(20 * 1024 * 1024);
    expect(createValueStore().budgetBytes).toBe(VALUE_STORE_BYTE_BUDGET_BYTES);
  });

  it('returns the stored value unchanged in the in-memory implementation', () => {
    const store = createValueStore(64);
    expect(store.store('abc')._unsafeUnwrap()).toBe('abc');
  });

  it('accumulates metered bytes across stores', () => {
    const store = createValueStore(64);
    store.store('abcd')._unsafeUnwrap();
    store.store('ef')._unsafeUnwrap();
    expect(store.usedBytes()).toBe(12);
  });

  it('rejects a store that would exceed the budget', () => {
    const store = createValueStore(10);
    store.store('abcd')._unsafeUnwrap();
    const breach = store.store('xy')._unsafeUnwrapErr();
    expect(breach).toEqual({ usedBytes: 8, attemptedBytes: 4, budgetBytes: 10 });
  });

  it('does not count a rejected store against the meter', () => {
    const store = createValueStore(14);
    store.store('abcdef')._unsafeUnwrap();
    expect(store.store('xy').isErr()).toBe(true);
    expect(store.usedBytes()).toBe(12);
  });

  it('resolves a value to itself in the in-memory implementation', () => {
    const store = createValueStore(64);
    const value = { label: 'x' };
    expect(store.resolve(value)).toBe(value);
  });
});

describe('createValueStore — sharing the budget between concurrent claimants', () => {
  it('offers a lone claimant everything the budget has left', () => {
    const store = createValueStore(64);
    store.store('abcd')._unsafeUnwrap();
    expect(store.reserve().allowanceBytes).toBe(56);
  });

  it('splits the free budget between the concurrent claimants the ceiling admits', () => {
    const store = createValueStore();
    store.setConcurrencyCeiling(MAX_SELECTED_MODELS);
    const slices = Array.from(
      { length: MAX_SELECTED_MODELS },
      () => store.reserve().allowanceBytes
    );
    expect(slices).toEqual(
      Array.from(
        { length: MAX_SELECTED_MODELS },
        () => VALUE_STORE_BYTE_BUDGET_BYTES / MAX_SELECTED_MODELS
      )
    );
  });

  it('returns a released slice to the claimants still to come', () => {
    const store = createValueStore(1000);
    store.setConcurrencyCeiling(2);
    const first = store.reserve();
    const second = store.reserve();
    first.release();
    second.release();
    expect(store.reserve().allowanceBytes).toBe(500);
  });

  it('offers nothing once committed bytes have overrun the outstanding slices', () => {
    const store = createValueStore(1000);
    store.setConcurrencyCeiling(2);
    store.reserve();
    store.store('x'.repeat(400))._unsafeUnwrap();
    expect(store.reserve().allowanceBytes).toBe(0);
  });

  it('offers nothing to a claimant arriving past the ceiling it was given', () => {
    const store = createValueStore(1000);
    store.setConcurrencyCeiling(2);
    store.reserve();
    store.reserve();
    expect(store.reserve().allowanceBytes).toBe(0);
  });
});
