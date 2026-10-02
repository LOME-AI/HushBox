import { describe, expect, it } from 'vitest';
import { hasProviderInternals } from './coverage-provider-host.js';

/** Every internal the batched override drives, in the shape the base class holds them. */
function upstreamInternals(): Record<string, unknown> {
  return {
    pendingPromises: [],
    coverageFiles: new Map(),
    coverageFilesDirectory: '/coverage',
    ctx: { getProjectByName: () => undefined },
    globCache: new Map(),
    options: { exclude: [] },
  };
}

describe('hasProviderInternals', () => {
  it('accepts a provider carrying every internal the override drives', () => {
    expect(hasProviderInternals(upstreamInternals())).toBe(true);
  });

  it('refuses a provider whose glob cache upstream has renamed away', () => {
    const renamed = Object.fromEntries(
      Object.entries(upstreamInternals()).filter(([field]) => field !== 'globCache')
    );

    expect(hasProviderInternals(renamed)).toBe(false);
  });

  it('refuses a provider whose dump registry is no longer a map', () => {
    expect(hasProviderInternals({ ...upstreamInternals(), coverageFiles: {} })).toBe(false);
  });
});
