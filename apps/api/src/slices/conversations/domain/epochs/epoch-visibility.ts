/**
 * The epoch floor every conversations-slice read applies: a member sees a
 * message only from the epoch their membership was seated at onward, so a
 * late joiner never reaches content written before they arrived.
 *
 * Every read that already holds the rows decides here. A read that must apply
 * the floor inside its own query instead — the message-history page, so that
 * `LIMIT` counts only visible rows — states the comparison as a SQL `gte` of
 * `messages.epochNumber` against the member's `visibleFromEpoch`, and any such
 * restatement moves with this one.
 *
 * The key-chain floor is a separate rule that reads alike and is not this: it
 * bounds `epochs.epochNumber` by the lowest `visibleFromEpoch` across the wraps
 * a member actually holds, and is documented with `keyChainFloor`. Changing
 * one does not imply changing the other.
 */
export function isVisibleAtFloor(epochNumber: number, visibleFromEpoch: number): boolean {
  return epochNumber >= visibleFromEpoch;
}
