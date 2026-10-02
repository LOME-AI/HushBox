import { describe, expect, it } from 'vitest';

import { envConfig } from './env/env.config.ts';
import * as barrel from './index.ts';

/**
 * `env.config.ts` carries every backend variable name and the credential-shaped
 * placeholders the non-production modes hold. Three public dists (`apps/web`,
 * `apps/marketing`, `apps/admin`) import this barrel, so whatever the barrel can
 * reach is a candidate for inlining into a browser bundle.
 *
 * Whether the barrel REACHES the registry is a module-graph property, and the
 * `published-doors-stay-browser-safe` architecture rule holds it — over every
 * published door rather than this one, counting the package's own specifier as
 * an edge, and throwing on an edge it cannot follow instead of walking past it.
 * What is left here is the property that graph cannot see: a value that carries
 * the registry's contents without an edge to the module declaring it, which is
 * what a spread copy or a hand-written twin would be. Matched by content rather
 * than by export name so a rename cannot slip past.
 */
function carriesRegistry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.keys(envConfig).every((name) => name in value);
}

describe('the shared barrel', () => {
  it('re-exports nothing carrying the backend environment registry', () => {
    const carriers = Object.entries(barrel)
      .filter(([, value]) => carriesRegistry(value))
      .map(([name]) => name);

    expect(carriers).toEqual([]);
  });
});
