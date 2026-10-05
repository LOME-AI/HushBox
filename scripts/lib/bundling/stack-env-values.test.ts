import { describe, expect, it } from 'vitest';

import { checkStackEnvValues } from './stack-env-values.js';

/** The inlined `import.meta.env` object as a minified build bakes it, in one chunk. */
function bakedChunk(entries: Readonly<Record<string, string>>): Map<string, string> {
  const fields = Object.entries(entries)
    .map(([key, value]) => `${key}:\`${value}\``)
    .join(',');
  return new Map([['assets/index-abc.js', `const e={${fields}};`]]);
}

const DECLARED = new Map([
  ['VITE_API_URL', 'https://api.example.test'],
  ['VITE_PLATFORM', 'web'],
]);

describe('checkStackEnvValues for a build that overrides some of the file', () => {
  it('admits another value for a key the build declares it overrides', () => {
    const sources = bakedChunk({ VITE_API_URL: 'https://api.example.test', VITE_PLATFORM: 'ios' });

    expect(checkStackEnvValues(sources, DECLARED, new Set(['VITE_PLATFORM']))).toEqual([]);
  });

  it('reports another value for a key the build does not declare it overrides', () => {
    const sources = bakedChunk({ VITE_API_URL: 'https://elsewhere.test', VITE_PLATFORM: 'ios' });

    const violations = checkStackEnvValues(sources, DECLARED, new Set(['VITE_PLATFORM']));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('VITE_API_URL="https://elsewhere.test"');
  });

  it('reports a key the file declares nothing for, whatever the build overrides', () => {
    const sources = bakedChunk({
      VITE_API_URL: 'https://api.example.test',
      VITE_PLATFORM: 'web',
      VITE_UNREGISTERED: 'planted',
    });

    const violations = checkStackEnvValues(sources, DECLARED, new Set(['VITE_PLATFORM']));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('VITE_UNREGISTERED');
  });

  it('reports a key the build overrides where the file declares nothing for it', () => {
    const sources = bakedChunk({ VITE_API_URL: 'https://api.example.test', VITE_PLATFORM: 'ios' });
    const withoutPlatform = new Map([['VITE_API_URL', 'https://api.example.test']]);

    const violations = checkStackEnvValues(sources, withoutPlatform, new Set(['VITE_PLATFORM']));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('declares nothing for');
  });

  it('holds every key to the file for a build that overrides nothing', () => {
    const sources = bakedChunk({ VITE_API_URL: 'https://api.example.test', VITE_PLATFORM: 'ios' });

    const violations = checkStackEnvValues(sources, DECLARED, new Set());

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('VITE_PLATFORM="ios"');
  });
});
