import { z } from 'zod';

/**
 * The turn's sender, discriminated by principal kind: a member sends as `user`
 * (its `userId`), a shared-link visitor as `linkGuest` (the `linkId` its
 * credential resolved to). The paying identity is separate and diverges from
 * this one on every owner-funded turn.
 *
 * The ONE declaration of the sender shape, from the route that resolves it
 * through the wire body, the run identity and settlement — it is also the wire
 * schema the worker→DO run-start and run-stop bodies embed, so the parsed body
 * and the in-process type cannot be two shapes that drift. It deliberately
 * carries no `conversation_members.id`: membership is re-resolved server-side
 * from this principal at every gate that needs it, so a second spelling of the
 * sender could not drift from this one.
 */
export const senderPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('linkGuest'),
    linkId: z.string().min(1),
  }),
]);

/**
 * `Readonly` rather than the bare inference: the sender is an authorization
 * input every consumer only reads, and Zod's own `.readonly()` would buy the
 * same modifiers by freezing the parsed object at runtime — a wire-parse
 * behaviour change for a compile-time guarantee.
 */
export type SenderPrincipal = Readonly<z.infer<typeof senderPrincipalSchema>>;

/**
 * The sender's principal id — a member's `userId`, a link guest's `linkId`.
 * It persists to `messages.senderId` (a guest holds no userId), keys the
 * sender's chat rate limit and socket eviction, and names the sender on billed
 * rows. Never the paying owner: the payer is a separate identity that diverges
 * from this one on every owner-funded turn.
 *
 * Shared across packages because every caller — the chat routes' rate-limit key,
 * the turn context, settlement and the conversation DO — must derive the same
 * id from the same sender, and a second derivation would silently change which
 * bucket a sender counts against.
 */
export function senderPrincipalId(sender: SenderPrincipal): string {
  return sender.kind === 'user' ? sender.userId : sender.linkId;
}
