import { describe, it, expect } from 'vitest';
import { ENV_MODE_VARIABLE } from './lib/stack/stack-mode.js';
import { siteBuildArguments } from './build-marketing-site.js';

describe('the arguments a site build runs under', () => {
  it('names the mode the stack selector resolves', () => {
    expect(siteBuildArguments(undefined, { [ENV_MODE_VARIABLE]: 'e2e' })).toEqual([
      'build',
      '--mode',
      'e2e',
    ]);
  });

  it('names the configuration its caller asked for', () => {
    expect(siteBuildArguments('astro.config.preview.mjs', { [ENV_MODE_VARIABLE]: 'test' })).toEqual(
      ['build', '--config', 'astro.config.preview.mjs', '--mode', 'test']
    );
  });

  it('names production where the environment names that mode', () => {
    expect(siteBuildArguments(undefined, { [ENV_MODE_VARIABLE]: 'production' })).toEqual([
      'build',
      '--mode',
      'production',
    ]);
  });

  it('refuses a site build whose environment names no mode at all', () => {
    expect(() => siteBuildArguments(undefined, {})).toThrow(ENV_MODE_VARIABLE);
  });
});
