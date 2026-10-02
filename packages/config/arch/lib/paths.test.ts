import { describe, expect, it } from 'vitest';
import { failWith } from './paths.js';

describe('failWith', () => {
  it('names the rule that could not read its own subject', () => {
    const fail = failWith('a-rule');
    expect(() => {
      fail('the map names no file.');
    }).toThrow('a-rule: the map names no file.');
  });
});
