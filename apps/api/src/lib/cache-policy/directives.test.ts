import { describe, expect, it } from 'vitest';
import { cacheDirectives } from './directives.js';

describe('rendering a policy into response directives', () => {
  it('refuses storage to every cache for the default policy', () => {
    expect(cacheDirectives({ kind: 'no-store' })).toEqual({
      cacheControl: 'private, no-store',
      cacheTag: undefined,
    });
  });

  it('binds a shared policy to caches the caller does not own', () => {
    expect(cacheDirectives({ kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'banner' })).toEqual({
      cacheControl: 'public, s-maxage=60',
      cacheTag: 'banner',
    });
  });

  it('lets a shared policy serve stale while it revalidates', () => {
    expect(
      cacheDirectives({
        kind: 'shared',
        sharedMaxAgeSeconds: 3600,
        staleWhileRevalidateSeconds: 600,
        tag: 'stats',
      })
    ).toEqual({
      cacheControl: 'public, s-maxage=3600, stale-while-revalidate=600',
      cacheTag: 'stats',
    });
  });

  it('lets a shared policy serve stale when its upstream errors', () => {
    expect(
      cacheDirectives({
        kind: 'shared',
        sharedMaxAgeSeconds: 3600,
        staleWhileRevalidateSeconds: 600,
        staleIfErrorSeconds: 86_400,
        tag: 'roadmap',
      })
    ).toEqual({
      cacheControl: 'public, s-maxage=3600, stale-while-revalidate=600, stale-if-error=86400',
      cacheTag: 'roadmap',
    });
  });

  it('writes no s-maxage for an immutable policy, so it stays outside the cross-origin grant', () => {
    expect(cacheDirectives({ kind: 'immutable', maxAgeSeconds: 86_400, tag: 'ota' })).toEqual({
      cacheControl: 'public, max-age=86400, immutable',
      cacheTag: 'ota',
    });
  });
});
