/**
 * The bound on in-flight push requests, shared by both transports so neither
 * can be the one that leaves it unbounded. Set to the platform's simultaneous-
 * outbound-connection cap, the same number the catalog walk observes and the
 * reason the media GC deletes one object at a time. Each transport bounds only
 * its own partition and the composite dispatches the native and web partitions
 * at once, so a message carrying both can hold up to twice this many
 * connections; exceeding the platform cap queues rather than errors.
 */
export const PUSH_FAN_OUT_CONCURRENCY = 6;
