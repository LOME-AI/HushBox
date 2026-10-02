import { describe, it } from 'vitest';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import type { TokenMapping } from './markdown.js';

/**
 * Compile-time assertion: the `@ts-expect-error` claims a mapping without one of marked's
 * token kinds does not compile, so a kind left unmapped leaves the directive unused and
 * fails the typecheck gate. The runtime half only proves the witness exists.
 */
describe('the markdown token mapping type', () => {
  it('refuses a mapping that leaves a token kind unmapped', () => {
    const widen = (mapping: Omit<TokenMapping, 'del'>): TokenMapping =>
      // @ts-expect-error — every token kind marked can produce needs its mapping
      mapping;
    expectCompileTimeProof(() => widen);
  });
});
