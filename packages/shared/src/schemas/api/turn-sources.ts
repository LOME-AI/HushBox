import { z } from 'zod';
import { MAX_SELECTED_MODELS } from '../../constants.ts';

/**
 * The answer sources one chat turn is sent to, in the order the client selected
 * them — the single wire vocabulary shared by the paid, guest, regenerate and
 * trial routes.
 *
 * Order is carried rather than incidental: it drives tile display order, so an
 * unordered record could not express the selection. A source is a discriminated
 * object rather than a reserved string id because the Smart slot names no model
 * — it is a distinct kind, and encoding it as a magic id is what let every
 * anchor-first branch treat it as an ordinary model.
 *
 * Not named `answerSources`: `Selection.answerSources` is the money layer's
 * UNORDERED `{ models, smartSlot }` record, and files hold both.
 */
const turnSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('smart') }),
  z.strictObject({ kind: z.literal('model'), id: z.string().min(1) }),
]);
export type TurnSource = z.infer<typeof turnSourceSchema>;

/**
 * The turn's ordered sources, bounded by the fan-out width cap, by at most ONE
 * Smart slot, and by naming each pinned model at most once.
 *
 * The slot bound lives here rather than in a route guard because the money
 * layer's selection carries a boolean `smartSlot`, not a count: a second slot
 * has nowhere to be represented, so it must never be expressible on the wire.
 * A refusal further in would have to be remembered by every route; a bound here
 * cannot be forgotten.
 *
 * The uniqueness bound is here for the same reason and one of its own: the turn
 * builders fan out one billed generation per entry, keyed by position, so a
 * repeated id is a second charge for an answer nothing in the product shows as
 * asked for twice. Refusing on the wire keeps it upstream of admission.
 */
export const turnSourceListSchema = z
  .array(turnSourceSchema)
  .min(1)
  .max(MAX_SELECTED_MODELS)
  .refine((sources) => sources.filter((source) => source.kind === 'smart').length <= 1, {
    message: 'at most one smart source per turn',
  })
  .refine(
    (sources) => {
      const pinned = pinnedSourceIds(sources);
      return new Set(pinned).size === pinned.length;
    },
    { message: 'a model may answer a turn only once' }
  );
export type TurnSourceList = z.infer<typeof turnSourceListSchema>;

/** The ids the client PINNED by name, in wire order. The Smart slot names none. */
export function pinnedSourceIds(sources: readonly TurnSource[]): readonly string[] {
  return sources.flatMap((source) => (source.kind === 'model' ? [source.id] : []));
}

/** Whether the turn carries the Smart slot — at ANY position, never only the head. */
export function smartSlotSelected(sources: readonly TurnSource[]): boolean {
  return sources.some((source) => source.kind === 'smart');
}
