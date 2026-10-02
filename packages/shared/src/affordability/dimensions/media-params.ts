/**
 * The catalog parameter vocabulary the media dimensions read their domains from
 * — one object, shared by the site that MINTS a media ParamSpec and every site
 * that LOOKS ONE UP.
 *
 * The coupling this closes is quiet and total: a media dimension resolves its
 * options by looking up `model.parameters[<name>]`, so if the normalizer that
 * mints the spec and the dimension that reads it ever disagree on a key, every
 * media dimension reports an empty domain — greying nothing, throwing nothing,
 * and offering the user no options at all. Two independently-written key lists
 * are the sync contract `docs/CODE-RULES.md` §One Implementation, Shared bans by
 * name, so the emitter imports these names rather than writing string literals:
 * renaming an axis is then a compile error at the mint site instead of silence.
 */

import { MEDIA_DIMENSION_IDS } from './types.ts';
import type { MediaDimensionId } from './types.ts';
import type { ParamSpec as ParameterSpec } from '../model/param-spec.ts';

/**
 * The catalog parameter name each media dimension's domain lives under. The
 * dimension id IS the catalog key — this map is written out rather than derived
 * from {@link MEDIA_DIMENSION_IDS} so that divergence, if the two ever must
 * differ, is a value change here instead of a new second list somewhere else.
 */
export const MEDIA_PARAMETER_NAMES = {
  aspectRatio: 'aspectRatio',
  resolution: 'resolution',
  durationSeconds: 'durationSeconds',
} as const satisfies Record<MediaDimensionId, string>;

export type MediaParameterName = (typeof MEDIA_PARAMETER_NAMES)[MediaDimensionId];

/** The value domain a source declares for each media axis it constrains. */
export type DeclaredMediaDomains = Partial<Record<MediaDimensionId, readonly (string | number)[]>>;

/**
 * The media half of a model's `parameters` record, minted from the domains a
 * source declares. Every media-spec producer goes through here — the catalog
 * normalizer over gateway metadata, and any client-side projection rebuilding
 * the record from the wire — so the axis names and the spec shape are minted
 * once.
 */
export function mediaParameterSpecs(declared: DeclaredMediaDomains): Record<string, ParameterSpec> {
  const specs: Record<string, ParameterSpec> = {};
  for (const id of MEDIA_DIMENSION_IDS) {
    const values = declared[id];
    // An empty domain is an UNCONSTRAINED axis, never a spec with no members:
    // `ParamSpec.values` is `.min(1)`, so minting one would fail the descriptor's
    // own schema at persist time.
    if (values === undefined || values.length === 0) continue;
    specs[MEDIA_PARAMETER_NAMES[id]] = {
      type: 'enum',
      values: [...values],
      wire: 'providerOptions',
    };
  }
  return specs;
}
