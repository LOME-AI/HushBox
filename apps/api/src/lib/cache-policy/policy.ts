/**
 * The vocabulary a route's cacheability is written in. It lives here rather
 * than beside the map because both ends need it and they sit on opposite sides
 * of the perimeter: the composition root writes the declarations, the pipeline
 * stage reads them, and middleware may not import the composition root.
 *
 * What a route's response may be stored in, and on what terms. `no-store` is
 * the default member because forgetting must fail safe: a route nobody
 * considered is refused storage rather than stored under whatever the
 * platform's heuristics would pick. `tag` is required rather than optional on
 * a storable member, and it buys less than that requirement suggests: the
 * cache partitions by Worker version, so a deploy starts cold with or without
 * a tag (`apps/api/wrangler.toml`). What requiring it keeps open is purging a
 * subset of still-live entries, which nothing here does.
 *
 * The two storable kinds differ in WHOSE cache they bind. `shared` writes
 * `s-maxage`, which binds shared caches only, so a browser still revalidates;
 * `immutable` writes `max-age` plus `immutable`, which also lets the caller
 * store it and never ask again — legal only for a body that can never change
 * under its own URL.
 */
export type CachePolicy =
  | { readonly kind: 'no-store' }
  | {
      readonly kind: 'shared';
      readonly sharedMaxAgeSeconds: number;
      readonly staleWhileRevalidateSeconds?: number;
      readonly staleIfErrorSeconds?: number;
      readonly tag: string;
    }
  | { readonly kind: 'immutable'; readonly maxAgeSeconds: number; readonly tag: string };
