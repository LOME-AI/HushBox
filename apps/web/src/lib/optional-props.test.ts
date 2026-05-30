import { describe, it, expect } from 'vitest';
import { omitUndefined } from './optional-props.js';

describe('omitUndefined', () => {
  it('returns an empty object when every value is undefined', () => {
    expect(omitUndefined({ a: undefined, b: undefined })).toEqual({});
  });

  it('keeps defined values, drops undefined values', () => {
    expect(omitUndefined({ a: 1, b: undefined, c: 'hi' })).toEqual({ a: 1, c: 'hi' });
  });

  it('keeps null values (only undefined is dropped)', () => {
    expect(omitUndefined({ a: null, b: undefined })).toEqual({ a: null });
  });

  it('keeps falsy non-undefined values like 0 and empty string', () => {
    expect(omitUndefined({ a: 0, b: '', c: false, d: undefined })).toEqual({
      a: 0,
      b: '',
      c: false,
    });
  });

  it('returns a new object (does not mutate input)', () => {
    const input = { a: 1, b: undefined };
    const output = omitUndefined(input);
    expect(output).not.toBe(input);
    expect(input).toEqual({ a: 1, b: undefined });
  });
});
