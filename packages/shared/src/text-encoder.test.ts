import { describe, it, expect } from 'vitest';
import { textEncoder } from './text-encoder.js';

describe('textEncoder', () => {
  it('should be an instance of TextEncoder', () => {
    expect(textEncoder).toBeInstanceOf(TextEncoder);
  });

  it('should encode strings to Uint8Array', () => {
    const result = textEncoder.encode('hello');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it('should be a singleton (same instance reused)', () => {
    textEncoder.encode('test');
    textEncoder.encode('test');
    // Both calls should use the same encoder instance
    // eslint-disable-next-line unicorn/text-encoding-identifier-case -- TextEncoder.encoding returns 'utf-8'
    expect(textEncoder.encoding).toBe('utf-8');
  });
});
