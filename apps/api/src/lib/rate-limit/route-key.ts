import type { ExtractSchema, MergeSchemaPath, Schema } from 'hono/types';

/**
 * `${method} ${path}` for every route in the schema. It reads off an
 * INTERSECTION: `.route()` chaining unions one schema per mount, and
 * `ExtractSchema` intersects that union, so a plain `keyof` reaches every path.
 * Reading the union directly yields nothing — `keyof` a union is the
 * intersection of its members' keys.
 */
export type RouteKeyOf<TSchema> = {
  [Path in keyof TSchema]: {
    [Method in keyof TSchema[Path]]: `${Method & string} ${Path & string}`;
  }[keyof TSchema[Path]];
}[keyof TSchema];

/**
 * The route keys ONE slice manifest contributes to the assembled app, prefixed
 * exactly as `.route()` prefixes them. It composes the same Hono types the
 * app-level union is read off, so a slice's own declaration and the app's
 * cannot disagree about how a path is spelled — there is one prefixing
 * implementation, not two that must agree.
 *
 * The schema is matched into a `Schema`-constrained parameter rather than
 * handed to `MergeSchemaPath` directly: `ExtractSchema` is unconstrained, so
 * its application to a type parameter satisfies no constraint until it is
 * resolved.
 */
export type SliceRouteKey<TManifest> = TManifest extends {
  readonly basePath: infer TBasePath extends string;
  readonly routes: infer TRoutes;
}
  ? ExtractSchema<TRoutes> extends infer TSchema extends Schema
    ? RouteKeyOf<MergeSchemaPath<TSchema, TBasePath>>
    : never
  : never;
