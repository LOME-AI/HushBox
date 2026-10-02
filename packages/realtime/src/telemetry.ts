/**
 * The room's observability seam: a CLOSED event set instead of free-form
 * messages, so the package carries no content-capable logging surface at
 * all. The worker binds each event to its typed Telemetry port with a
 * literal message (packages never import apps).
 */
export interface RoomTelemetry {
  runStarted(fields: { conversationId: string; runId: string }): void;
  runFinished(fields: { conversationId: string; runId: string; errorCode?: string }): void;
  runRejected(fields: { conversationId: string; errorCode: string }): void;
  deadlineFired(fields: { conversationId: string; runId: string }): void;
  /** A principal failed broadcast-time revalidation and was cut. */
  principalEvicted(fields: { conversationId: string }): void;
  /** Verification infrastructure is down past the last-known-good window. */
  deliveryPaused(fields: { conversationId: string }): void;
  /**
   * A delivery queued on the room's ordering chain rejected. The chain is
   * terminated at the failure so later frames still fan out, which makes this
   * line the only trace a degraded delivery leaves. No watcher reads it: like
   * the two events above it exists so the degradation is not silent, and
   * realtime delivery is best-effort — the turn still completes, persists and
   * bills server-side.
   */
  deliveryFailed(fields: { conversationId: string }): void;
  /**
   * A principal that was paused or evicted at broadcast is delivering again.
   * Emitted on the TRANSITION only, as its pause/evict counterparts are: what
   * the room re-decides every frame is a condition, and frames are stream
   * tokens, so emitting per frame would make log volume track throughput at
   * exactly the moment the system is degraded. No watcher reads it; it exists
   * so a pause line in an incident has a visible end.
   */
  deliveryResumed(fields: { conversationId: string }): void;
  clientMessageRejected(fields: { conversationId: string }): void;
  /**
   * A WebSocket upgrade the DO refused because the connection parameters it
   * parses did not validate. Emitted through the bound telemetry logger as a
   * warn line with no watcher: nothing reads it, and it fires on the room's own
   * parameter parse rather than on a client blocked upstream, so no
   * upgrade-failure rate derives from it.
   */
  upgradeRejected(fields: { conversationId: string }): void;
  /**
   * One billable gateway generation completed (a `step-finish`). Emitted
   * through the bound telemetry logger as an info line with no watcher. It
   * carries the actual `generationId` (an opaque provider id), with `runId`
   * grouping the run and `conversationId` scoping it — but nothing reads or
   * stores the line, so a killed run, which commits no `usage_records` row,
   * leaves its provider spend unreconcilable against OpenRouter after the fact.
   */
  billableGeneration(fields: { conversationId: string; runId: string; generationId: string }): void;
}
