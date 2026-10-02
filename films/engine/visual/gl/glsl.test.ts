import { describe, expect, it } from 'vitest';

import { GLSL_HEADER } from './glsl.js';

describe('GLSL_HEADER', () => {
  it('opens a GLSL ES 3.00 source at high precision for floats and ints', () => {
    expect(GLSL_HEADER).toBe('#version 300 es\nprecision highp float;\nprecision highp int;\n');
  });
});
