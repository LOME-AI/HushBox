import { describe, expect, it } from 'vitest';

import { assertRegistration } from './entry.js';
import { NEUTRAL_POST } from './post.js';

import type { GlContext, GlLayer } from './layer.js';

function layer(samples: number): GlLayer {
  return {
    id: 'fire',
    samples,
    prepare: (_context: GlContext): boolean => true,
    draw: (_context: GlContext): void => undefined,
  };
}

describe('assertRegistration', () => {
  it('accepts layers with a whole sample count', () => {
    expect(() => {
      assertRegistration({ kind: 'layers', layers: [layer(1)] });
    }).not.toThrow();
  });

  it('refuses a layer whose sample count is not a number, naming the layer', () => {
    expect(() => {
      assertRegistration({ kind: 'layers', layers: [layer(Number.NaN)] });
    }).toThrow(/"fire".*samples/);
  });

  it('refuses a layer with zero samples, naming the layer', () => {
    expect(() => {
      assertRegistration({ kind: 'layers', layers: [layer(0)] });
    }).toThrow(/"fire".*samples/);
  });

  it('accepts a well-formed post chain', () => {
    expect(() => {
      assertRegistration({ kind: 'post', post: NEUTRAL_POST });
    }).not.toThrow();
  });

  it('refuses a post chain value that is not a number, naming it', () => {
    expect(() => {
      assertRegistration({ kind: 'post', post: { ...NEUTRAL_POST, flash: Number.NaN } });
    }).toThrow(/post\.flash/);
  });
});
