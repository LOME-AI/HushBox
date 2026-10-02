/**
 * THE text-turn pool projection: the one answer to "is this catalog row a model
 * the token turn may draw on, and what are its money inputs".
 *
 * It exists because the server's admission builder and the client's option
 * producer draw the same pool from two different carriers — a catalog
 * descriptor and a served wire row — and a pool drawn twice is a pool that can
 * disagree. It did: the server's draw was a strict superset of the client's for
 * a free payer, so a classifier could route a payer onto a model the picker
 * never presented.
 *
 * WHAT THIS GUARANTEES, stated exactly, because the stronger claim was false.
 * There is one set of membership RULES, so neither side can grade a row the
 * other would grade differently. It does NOT make every divergence impossible:
 * a carrier can withhold a row before the projection ever sees it, and the wire
 * contract refuses rows on fields the money layer never reads (a missing display
 * name, an inconsistent pricing shape). What is pinned instead is that no rule
 * HERE keeps a row the wire contract refuses — see the cap leg below, which was
 * the one shape that measurably diverged.
 *
 * Three legs, each of which removes rows the others keep, plus the rate rules
 * {@link projectPriceable} owns:
 *
 * 1. RUNNABLE SHAPE — text must be an accepted input (other input modalities are
 *    allowed, since a text turn only ever sends text) and the single output must
 *    be text. A vision model qualifies; a text+image-OUTPUT or multi-output model
 *    does not, because the engine cannot run it as a text turn.
 * 2. CAPS IN WHOLE TOKENS — an absent, zero or non-finite window has no ceiling
 *    to solve, and a FRACTIONAL cap excludes rather than floors. Flooring is what
 *    let the two carriers disagree: the gateway types `context_length` without
 *    `.int()`, the wire contract refuses a non-integer cap outright, and a
 *    floored row therefore sat in the server pool and in no client pool.
 * 3. RELEASE DATE — premium classification's recency leg is a money verdict, and
 *    a row with no release date would make every recency test false, turning a
 *    premium row available rather than refusing it. Absence excludes.
 */

import { isRunnableModelShape } from './model-descriptor.ts';
import { projectPriceable, releasedAtMsOf } from './priceable-model.ts';
import type { Modality } from './modality.ts';
import type { ModelDescriptor, ModelReasoning } from './model-descriptor.ts';
import type { PriceableModel } from './priceable-model.ts';
import type { ModelPricing } from '../price/schedule.ts';

/**
 * The narrow row the projection reads. Structural rather than named after either
 * carrier: a shape both a catalog descriptor and a served wire row can be
 * adapted onto is what stops either side growing a projection of its own.
 */
export interface PoolCandidateRow {
  readonly id: string;
  readonly inputs: readonly Modality[];
  readonly outputs: readonly Modality[];
  readonly pricing: ModelPricing;
  /** The context window in tokens, as the carrier declares it. */
  readonly contextLength: number | undefined;
  /** The provider completion ceiling; absent leaves the context window bounding. */
  readonly maxOutputTokens: number | undefined;
  readonly reasoning: ModelReasoning | undefined;
  /** The release date in UNIX SECONDS, as both carriers date a model. */
  readonly releasedAtSeconds: number | undefined;
}

/** A declared cap the wire contract would refuse: present but not a whole number. */
function isFractionalCap(cap: number | undefined): boolean {
  return cap !== undefined && Number.isFinite(cap) && !Number.isInteger(cap);
}

/** The pool member's money projection, or `undefined` when the row is not one. */
export function poolModelFrom(row: PoolCandidateRow): PriceableModel | undefined {
  if (!isRunnableModelShape(row) || row.outputs[0] !== 'text') return undefined;
  if (row.releasedAtSeconds === undefined) return undefined;
  if (isFractionalCap(row.contextLength) || isFractionalCap(row.maxOutputTokens)) return undefined;
  return projectPriceable({
    id: row.id,
    pricing: row.pricing,
    contextLength: row.contextLength,
    maxOutputTokens: row.maxOutputTokens,
    reasoning: row.reasoning,
    releasedAtMs: releasedAtMsOf(row.releasedAtSeconds),
  });
}

/**
 * The pool member behind a catalog descriptor: the descriptor's adaptation onto
 * {@link poolModelFrom}, written once for every server-side caller.
 */
export function poolModelFromDescriptor(descriptor: ModelDescriptor): PriceableModel | undefined {
  return poolModelFrom({
    id: descriptor.id,
    inputs: descriptor.inputs,
    outputs: descriptor.outputs,
    pricing: descriptor.pricing,
    contextLength: descriptor.limits['contextLength'],
    maxOutputTokens: descriptor.limits['maxOutputTokens'],
    reasoning: descriptor.reasoning,
    releasedAtSeconds: descriptor.releasedAt,
  });
}
