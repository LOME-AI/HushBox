import { describe, expect, it } from 'vitest';

import { GlError } from './gl-error.js';

describe('GlError', () => {
  it('names itself so a failed render says which layer failed', () => {
    expect(new GlError('context-lost', 'the GPU reset').name).toBe('GlError');
  });

  it('carries the failure', () => {
    expect(new GlError('shader-compile', 'glyph: bad token').failure).toBe('shader-compile');
  });

  it('states the failure and its detail in the message', () => {
    expect(new GlError('shader-compile', 'glyph: bad token').message).toBe(
      'GlCanvas shader-compile: glyph: bad token'
    );
  });
});
