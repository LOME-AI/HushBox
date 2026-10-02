import { describe, expect, it } from 'vitest';

import * as shaders from './shaders.js';

const SOURCES = Object.entries(shaders).filter(
  (entry): entry is [string, string] => typeof entry[1] === 'string'
);

describe('the shader sources', () => {
  it('are all GLSL ES 3.00', () => {
    expect(SOURCES.filter(([, source]) => !source.startsWith('#version 300 es\n'))).toEqual([]);
  });

  it.each(SOURCES)('%s clamps the base of every pow, so no NaN reaches the frame', (_, source) => {
    const bases = [...source.matchAll(/\bpow\s*\(\s*([a-zA-Z]+)\s*\(/g)].map((match) => match[1]);
    const calls = [...source.matchAll(/\bpow\s*\(/g)];
    expect(bases).toHaveLength(calls.length);
    expect(bases.every((base) => base === 'max' || base === 'clamp')).toBe(true);
  });

  it('the pow check sees an unclamped base', () => {
    const unclamped = 'float x = pow(color.r, 2.2);';
    expect([...unclamped.matchAll(/\bpow\s*\(\s*([a-zA-Z]+)\s*\(/g)]).toHaveLength(0);
  });

  it('the blur reads one weight per tap of its radius and the centre', () => {
    expect(shaders.BLUR_FRAGMENT).toContain(`u_weights[${String(shaders.BLOOM_RADIUS + 1)}]`);
  });

  it('the finishing pass dithers from the pixel alone, never from time', () => {
    expect(shaders.PRESENT_FRAGMENT).not.toMatch(/u_time|u_frame/);
  });

  it('the plain pass encodes the scene to sRGB and nothing more', () => {
    expect(shaders.PLAIN_FRAGMENT).toContain('encodeSrgb(texture(u_scene, v_uv).rgb)');
    expect(shaders.PLAIN_FRAGMENT).not.toMatch(/rollOff|dither|u_bloom|u_vignette|u_flash/);
  });
});
