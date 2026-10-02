import { z } from 'zod';
import { Modality } from './modality.ts';
import { ParamSpec as ParameterSpec } from './param-spec.ts';
import { ModelPricingSchema } from '../price/schedule.ts';

/**
 * The closed set of SDK call-shape families. Dispatch keys on call shape,
 * not on model identity: a genuinely new modality is one enum migration plus
 * one dispatch adapter (ARCHITECTURE.md "Models & capabilities").
 */
export const CALL_SHAPE_FAMILIES = ['language', 'image', 'video', 'embedding'] as const;

export type CallShapeFamily = (typeof CALL_SHAPE_FAMILIES)[number];

/**
 * Descriptor outputs → call-shape family, total over every output
 * combination. Exposure gating (the dated-ZDR media gate) and adapter
 * routing MUST classify a descriptor identically — if they diverge, a
 * media-routed model can skip the media exposure gate — which is why this
 * single derivation is the only source both consume.
 *
 * Precedence: any text output streams through the language call-shape
 * (text+media models emit file parts); embedding beats bare media; image
 * beats video, so ['image','video'] is media-classified, never language;
 * no match returns `undefined` so callers exclude-with-alert, never guess.
 */
export function callShapeFamilyFor(outputs: readonly Modality[]): CallShapeFamily | undefined {
  if (outputs.includes('text')) return 'language';
  if (outputs.includes('embedding')) return 'embedding';
  if (outputs.includes('image')) return 'image';
  if (outputs.includes('video')) return 'video';
  return undefined;
}

/**
 * A model runs a turn iff it accepts text input (we send text today;
 * additional declared input modalities are allowed but currently unused)
 * AND produces exactly one routable output modality (text | image | video;
 * not audio, not embedding, not multi-output). This is the single shared
 * predicate both catalog admission (models slice) and the engine's port
 * derivation gate on — one definition so the two never diverge.
 */
export function isRunnableModelShape(shape: {
  readonly inputs: readonly Modality[];
  readonly outputs: readonly Modality[];
}): boolean {
  const family = callShapeFamilyFor(shape.outputs);
  return (
    shape.inputs.includes('text') &&
    shape.outputs.length === 1 &&
    family !== undefined &&
    family !== 'embedding'
  );
}

/**
 * OpenRouter's per-model top-level `reasoning` object, carried verbatim
 * (camelCased) — data, never interpreted here. `supportedEfforts` keeps the
 * upstream strings raw, including levels outside our canonical enum;
 * consumers intersect with the canonical set at use. The upstream tristate
 * is preserved: `null` = every effort accepted, absent = no effort
 * selection (budget-or-nothing model).
 */
export const ModelReasoning = z.object({
  /** `true` = reasoning cannot be disabled upstream (`effort:"none"` rejected). */
  mandatory: z.boolean().optional(),
  supportedEfforts: z.array(z.string()).nullable().optional(),
  /** Effort used when reasoning runs but the request names none. */
  defaultEffort: z.string().optional(),
  /** Model reasons by default with no `reasoning` param sent. */
  defaultEnabled: z.boolean().optional(),
});

export type ModelReasoning = z.infer<typeof ModelReasoning>;

/**
 * A model self-describes. Descriptors are data; modalities are the
 * closed enum. `zdrReachable` reflects membership in OpenRouter's
 * authoritative `/endpoints/zdr` list — models absent from it are treated
 * as unreachable and hidden (fail-closed).
 */
export const ModelDescriptor = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  version: z.string().min(1),
  inputs: z.array(Modality),
  outputs: z.array(Modality),
  parameters: z.record(z.string(), ParameterSpec),
  behaviors: z.array(z.string()), // 'streaming' | 'tools' | 'reasoning' | 'web-search' | …
  limits: z.record(z.string(), z.number()),
  // Billable nano-USD rates, fee baked: estimates and display only, never
  // billing truth (the gateway's per-generation cost is).
  pricing: ModelPricingSchema,
  zdrReachable: z.boolean(),
  // OpenRouter's per-model reasoning metadata. Optional and additive to the
  // persisted jsonb: descriptor rows written before this field — and the
  // 131/342 models with no reasoning object — parse unchanged; absence never
  // excludes a model.
  reasoning: ModelReasoning.optional(),
  // Human-readable display name from the source metadata, carried for the
  // frontend catalog (raw slugs alone are not user-facing). Optional and
  // defaulted-absent by design: additive to the persisted jsonb, so descriptor
  // rows written before this field parse unchanged — absence never excludes.
  name: z.string().optional(),
  // Human-readable model summary from the source metadata, carried for the
  // Smart Model classifier prompt. Optional by design: a model without one
  // renders id-only in the prompt — absence never excludes a model.
  description: z.string().optional(),
  // Release timestamp as UNIX SECONDS (OpenRouter's `created`). Required and
  // always present: a model whose source metadata carries no release date is
  // excluded at normalization (fail-closed), never exposed with the field
  // absent. Drives the trial premium-recency gate (multiply by 1000 for ms).
  releasedAt: z.number(),
  fetchedAt: z.number(),
  // OpenRouter top-weekly usage rank, 0-based (lower = more used); populated
  // from a DB column at read time, never persisted in the descriptor JSONB;
  // optional because media/unranked models have none.
  popularityRank: z.number().int().nonnegative().optional(),
});

export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

/**
 * The price kind each call-shape family charges by. A merged catalog row keeps
 * a price of its merged family's kind whenever either merged row carries one,
 * the model list serves rates only from a price of the listed family's kind,
 * and the browser projects a media row only when its price is of that kind, so
 * each reads this one map.
 */
export const PRICING_KIND_BY_FAMILY: Readonly<
  Record<CallShapeFamily, ModelDescriptor['pricing']['kind']>
> = {
  language: 'tokens',
  image: 'perImage',
  video: 'perSecond',
  embedding: 'tokens',
};

/**
 * The exposure decision — whether a catalog row may be sold to a client at all —
 * fail-closed on every leg:
 * - a ZDR-unreachable model stays hidden. `zdrReachable` is authoritative
 *   membership in OpenRouter's `/endpoints/zdr` set, so no separate dated
 *   verification is needed for image/video;
 * - a model priced at nothing never reaches this test: every price kind parses
 *   only with a positive rate for what it charges (both token legs, the image,
 *   at least one video resolution), so a descriptor that parsed is priced;
 * - an embedding (or unclassifiable) call shape stays hidden until an adapter
 *   ships — dispatch refuses the family, so a listed one would error on every
 *   call. Kept as its own leg rather than left to {@link isRunnableModelShape}:
 *   the two answer different questions, and widening runnability must not
 *   silently start exposing embeddings;
 * - a shape no turn can run stays hidden ({@link isRunnableModelShape}), which
 *   is defense in depth for rows persisted before admission enforced it.
 *
 * Shared because the API's catalog read and the E2E tooling that picks models to
 * drive tests with must answer this identically; a copy in the tooling had
 * already drifted a leg.
 */
export function isExposedModel(
  descriptor: Pick<ModelDescriptor, 'inputs' | 'outputs' | 'zdrReachable'>
): boolean {
  if (!descriptor.zdrReachable) return false;
  const family = callShapeFamilyFor(descriptor.outputs);
  if (family === undefined || family === 'embedding') return false;
  return isRunnableModelShape(descriptor);
}
