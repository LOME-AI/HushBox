import { match } from 'ts-pattern';
import type { CachePolicy } from './policy.js';

/**
 * The response headers a policy renders to, named for the headers they are
 * written onto. `cacheTag` is `undefined` exactly when nothing is storable,
 * since a tag on an unstorable response names an entry that will never
 * exist.
 */
export interface CacheDirectives {
  readonly cacheControl: string;
  readonly cacheTag: string | undefined;
}

/**
 * The single rendering of a policy into directives, beside the type it renders,
 * because the stage that writes the header and the test that proves no
 * undeclared response is storable must agree on it exactly. Two renderings that
 * had to agree would be the drift `CODE-RULES.md` §One Implementation, Shared
 * bans.
 *
 * `private, no-store` is the refusal, deliberately: `no-cache` stores and
 * revalidates and `max-age=0` stores and serves stale, so neither suppresses
 * storage.
 */
export function cacheDirectives(policy: CachePolicy): CacheDirectives {
  return match(policy)
    .with({ kind: 'no-store' }, () => ({
      cacheControl: 'private, no-store',
      cacheTag: undefined,
    }))
    .with({ kind: 'shared' }, (shared) => ({
      cacheControl: [
        `public, s-maxage=${String(shared.sharedMaxAgeSeconds)}`,
        ...(shared.staleWhileRevalidateSeconds === undefined
          ? []
          : [`stale-while-revalidate=${String(shared.staleWhileRevalidateSeconds)}`]),
        ...(shared.staleIfErrorSeconds === undefined
          ? []
          : [`stale-if-error=${String(shared.staleIfErrorSeconds)}`]),
      ].join(', '),
      cacheTag: shared.tag,
    }))
    .with({ kind: 'immutable' }, (immutable) => ({
      cacheControl: `public, max-age=${String(immutable.maxAgeSeconds)}, immutable`,
      cacheTag: immutable.tag,
    }))
    .exhaustive();
}
