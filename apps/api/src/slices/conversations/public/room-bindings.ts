/**
 * This slice's published surface for composing the ConversationRoom Durable
 * Object's worker-side bindings. A door rather than a barrel export because
 * the binding module imports `@hushbox/realtime` for value, and the barrel is
 * consumed by other slices' domain layers — routing this through the barrel
 * would put the workerd-only Durable Object runtime in every one of their
 * import graphs.
 *
 * The composition root supplies the chat runtime, identity's session-liveness
 * read and the push-notify factory, because this slice may import none of
 * those barrels.
 */
export { createRoomBindings } from '../adapters/realtime-room-bindings.js';
export type {
  PushNotifyCompositionDeps,
  PushNotifyFactory,
} from '../adapters/realtime-room-bindings.js';
