import { describe, expect, it } from 'vitest';
import {
  envConfig,
  Mode,
  resolveRaw,
  secret,
  type VariableConfig,
} from '@hushbox/shared/env.config';

import { SURFACES, SURFACE_ORIGINS } from './deployed-surfaces.js';

const HTTPS_ORIGIN = /^https:\/\/[^/]+$/;

/**
 * The origin variables whose production value is not a plain `https://` origin.
 * The env generator writes each production value into the probe's step as a
 * literal, so a secret-valued or missing one has no literal to write.
 */
function unprobeableOrigins(
  registry: Readonly<Record<string, VariableConfig>>,
  variables: readonly string[]
): string[] {
  return variables.filter((variable) => {
    const config = registry[variable];
    const value = config === undefined ? undefined : resolveRaw(config, Mode.Production);
    return typeof value !== 'string' || !HTTPS_ORIGIN.test(value);
  });
}

describe('SURFACES', () => {
  it('declares the Worker surfaces as directories holding their own configuration', () => {
    const workers = Object.entries(SURFACES)
      .filter(([, surface]) => surface.worker)
      .map(([directory]) => directory);

    expect(workers.toSorted((left, right) => left.localeCompare(right))).toEqual([
      'apps/admin',
      'apps/sandbox',
    ]);
  });
});

describe('SURFACE_ORIGINS', () => {
  it('names only variables whose production value in the registry is a plain https origin', () => {
    expect(unprobeableOrigins(envConfig, SURFACE_ORIGINS)).toEqual([]);
  });

  it('reports an origin variable whose production value is a secret', () => {
    const registry: Readonly<Record<string, VariableConfig>> = {
      SECRET_ORIGIN: { to: [], [Mode.Production]: secret('SECRET_ORIGIN') },
    };

    expect(unprobeableOrigins(registry, ['SECRET_ORIGIN'])).toEqual(['SECRET_ORIGIN']);
  });

  it('reports an origin variable whose production value is not https', () => {
    const registry: Readonly<Record<string, VariableConfig>> = {
      PLAIN_HTTP_ORIGIN: { to: [], [Mode.Production]: 'http://hushbox.ai' },
    };

    expect(unprobeableOrigins(registry, ['PLAIN_HTTP_ORIGIN'])).toEqual(['PLAIN_HTTP_ORIGIN']);
  });

  it('reports an origin variable the registry does not hold', () => {
    expect(unprobeableOrigins({}, ['MISSING_ORIGIN'])).toEqual(['MISSING_ORIGIN']);
  });
});
