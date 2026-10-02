/**
 * The served catalog row's adaptation onto {@link poolModelFrom}, written ONCE.
 *
 * It is here rather than in the client because the client is not its only
 * caller: whatever asserts that the two pools agree has to draw the client's
 * half the way the client draws it, and a test that rebuilds this adaptation
 * stays green precisely when the shipped one drifts — the agreement it claims
 * becomes false without anything going red. One function, imported by both, is
 * what removes that.
 *
 * Two adaptations, both wire facts rather than judgements:
 *
 * - TEXT INPUT IS DECLARED, not read. The wire carries no input-modality list,
 *   and a row is only ever served for a model the exposure gate already accepted
 *   as runnable, so the shape leg's input half is the server's established fact.
 *   The OUTPUT half is carried for real, off `modality`.
 * - THE SYNTHETIC SMART MODEL ROW is dropped before the projection sees it. It
 *   is the smart SLOT, carried on `Selection.answerSources.smartSlot`, and its
 *   headline pricing describes a range across a pool rather than one model's
 *   rates — so it has no pool membership to decide.
 *
 * Rates cross the wire as decimal strings and become a price through the one
 * wire adapter, which parses them: a row whose rates the schedule cannot
 * represent — an undeclared leg or a zero one — has no price rather than a free
 * one, and is no pool member.
 */

import { pricingFromWire } from '../price/wire.ts';
import { poolModelFrom } from './pool-projection.ts';
import type { Model } from '../../schemas/api/models.ts';
import type { PriceableModel } from './priceable-model.ts';

/** The pool member behind a served catalog row, or `undefined` when it is not one. */
export function poolModelFromWire(model: Model): PriceableModel | undefined {
  if (model.isSmartModel === true) return undefined;
  const pricing = pricingFromWire(model);
  if (pricing === undefined) return undefined;
  return poolModelFrom({
    id: model.id,
    inputs: ['text'],
    outputs: [model.modality],
    pricing,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    reasoning: model.reasoning,
    releasedAtSeconds: model.created,
  });
}
