/**
 * Fixed timeout budgets for E2E tests, in milliseconds.
 *
 * These are the single source of truth for every `timeout:` value in the E2E
 * suite. Values are fixed literals: there is no environment variable, no
 * multiplier, and no runtime scaling of any kind. A test is either reliable at
 * a given budget on every machine or it is broken — scaling timeouts hides the
 * breakage instead of surfacing it.
 *
 * Inline numeric `timeout:` literals are banned in specs and helpers (enforced
 * by lint); reference a named budget from this module instead.
 */
export const TIMEOUTS = {
  /** App reports it has finished its initial boot and is interactive. */
  APP_STABLE: 15_000,
  /** A client-side route transition has settled. */
  ROUTE: 20_000,
  /** A conversation's messages have loaded and decrypted. */
  CONVERSATION_LOAD: 15_000,
  /** A streamed LLM response has completed. */
  STREAM: 15_000,
  /**
   * A regeneration that clears the whole conversation and re-streams the first
   * turn — the heaviest single stream cycle (cascade-delete then a fresh
   * stream). Wider than STREAM so the cycle still completes when every browser
   * project's workers run at once and saturate the host (see resource-scan).
   */
  STREAM_CLEAR: 30_000,
  /**
   * A streamed turn whose first render can lag under the fully saturated matrix.
   * Wider than STREAM (which is sized for a warm, uncontended single stream) to
   * cover the two cases that legitimately run long when every browser project's
   * workers hammer the host at once: (1) a multi-model fan-out, where N streams
   * contend for the same CPU/socket/DB budget and a workerd recycle can drop one
   * mid-turn, forcing a reconnect+replay before all tiles settle; and (2) a
   * first message to a fresh conversation, whose ConversationRoom DO cold-starts
   * and competes for the ~128 MB shared isolate, so the first token can take far
   * longer than a warm follow-up. The token still arrives — it is starved, not
   * dropped — so the budget absorbs it instead of scaling at runtime.
   *
   * Coincides with STREAM_CLEAR at 30s today but is kept distinct: that one
   * bounds a regen's cascade-delete-then-restream, this one a saturated
   * first-token/fan-out. They can diverge if either profile changes.
   */
  STREAM_SATURATED: 30_000,
  /**
   * A media asset (image/video) has decoded and rendered. Covers the full
   * client chain after the turn streams: fetch the ciphertext (R2/MinIO),
   * decrypt it (WASM crypto), and decode the bytes — all main-thread work that
   * a saturated host serializes behind every other worker's browser, so the
   * rendered element can land past a 30s budget. Wider than STREAM so it absorbs
   * that without scaling at runtime.
   */
  MEDIA_DECODE: 45_000,
  /** A realtime WebSocket connection has completed its handshake. */
  WS_HANDSHAKE: 15_000,
  /** A modal/dialog has opened or closed. */
  MODAL: 5000,
  /** A scroll position has stabilized. */
  SCROLL_STABLE: 5000,
  /** An inbound webhook has been received and processed. */
  WEBHOOK: 30_000,
  /**
   * A transactional job enqueued for a near-future `scheduledAt` has been
   * claimed and executed by the alarm-clocked dispatcher. Sized as the spec's
   * deliberate schedule lead (the newsletter schedule op refuses non-future
   * instants, so specs must aim tens of seconds ahead) plus the dispatcher's
   * claim latency (alarm re-arm ≤30s) under a saturated host.
   */
  JOB_DISPATCH: 90_000,
  /**
   * A node-side API request has returned a terminal (non-transient) response.
   * Bounds the per-request retry budget that `withRequestRetry` wraps every
   * fixture context with: under host saturation a workerd/wrangler recycle
   * answers an in-flight request with a bare 5xx or severs the socket, and the
   * request is re-issued until it settles or this budget elapses.
   */
  API_SETUP: 15_000,
  /**
   * A development server a spec started itself has bound its port and answered
   * a request on it.
   *
   * Sized as an upper bound on that boot rather than as a measurement of it.
   * The admin development server answers its root about half a second after
   * the spawn, and about two thirds of a second when it is made to re-optimize
   * its dependencies first — the optimizer is not in this wait's path, because
   * the server answers the root document before any module request reaches it.
   * So this budget is not sizing work; it only has to be wide enough that a
   * saturated host cannot make a live server look dead, and narrow enough that
   * the failure lands inside the test carrying the server's own output rather
   * than expiring the per-test budget and naming nothing. Half of `LONG`
   * clears both, and leaves the rest of the budget for the requests the test
   * then makes, which are static reads measuring in milliseconds.
   *
   * Coincides with `TTS_WORKER_BOOT` at 30s, and for the same reason — both
   * bound a boot from above — but is kept distinct: that one bounds a worker
   * evaluating a model graph in the browser, this one a Node process binding a
   * port.
   */
  DEV_SERVER_ANSWERS: 30_000,
  /**
   * A marketing page's pageview beacon has been sent by the browser and
   * answered by the API worker. The watch is armed before the navigation that
   * makes the page send it, so the budget spans that navigation as well as the
   * request's round trip.
   *
   * Sized for the saturated case from what has been measured to recover, not
   * from the transport's warm cost — the beacon is one fire-and-forget `fetch`
   * against a same-origin route that runs a single Redis script, so what makes
   * this wait fail is never the work, it is the request or the navigation being
   * held. Beacons held for 16s, 25s and 30s have each been produced against the
   * marketing-analytics spec and shown to flush and let it complete, so a
   * budget at or under 30s converts a stall the run recovers from into a hard
   * failure; the widest budget this module grants a page transition is `ROUTE`
   * at 20s. 45s clears both with margin, and against the `XLONG` per-test
   * budget that spec raises itself to it still leaves about 75s for a journey
   * that measures under 2s unheld — so a genuinely dead beacon fails in
   * seconds, naming itself, rather than spending the test's whole budget and
   * naming nothing.
   *
   * Coincides with `MEDIA_DECODE` at 45s — the widest this suite grants any
   * real operation under saturation — but is kept distinct: that one bounds a
   * client-side fetch-decrypt-decode chain, this one a navigation plus one
   * request.
   */
  BEACON_ANSWERED: 45_000,
  /**
   * A best-effort transactional email has been captured by the dev mailbox.
   * The confirmation/issue send fires inside the triggering request's
   * best-effort chain (never a queue), so capture normally precedes the row
   * read-back; this budget absorbs the send lagging behind the row under a
   * saturated host without scaling at runtime.
   */
  MAILBOX_DELIVERY: 15_000,
  /**
   * The on-device text-to-speech worker has spawned, evaluated its module graph
   * (kokoro-js plus the ONNX runtime), taken delivery of the load message and
   * issued its first model-file request. Sized as an upper bound on that boot,
   * not as the thing being measured: what proves the worker alive is the
   * request itself, which a worker that died on load never issues, so the
   * budget only has to be wide enough that a saturated host cannot make a live
   * worker look dead. It stays far below the engine's own 120s load timeout, so
   * a stalled download cannot reach that timeout inside this budget and turn a
   * held request into an error state.
   */
  TTS_WORKER_BOOT: 30_000,
  /**
   * A real on-device TTS read has produced audio: the model weights (~92 MB)
   * and one voice (~522 KB) downloaded over localhost, the engine warmed up,
   * and the first chunk synthesized and scheduled on the AudioContext. Wider
   * than the engine's own 120s load timeout (`DEFAULT_LOAD_TIMEOUT_MS` in
   * `tts-engine.ts`) so a load that legitimately runs right up to that
   * internal bound still has room to synthesize afterward, rather than this
   * budget racing it.
   */
  TTS_SPEAK: 150_000,
  /**
   * The Worker's `scheduled()` handler has run one schedule's entries to
   * completion, `waitUntil` promises included — the scheduled endpoint holds
   * the response open until they settle, so this budget covers the slowest
   * schedule end to end rather than a request round trip.
   *
   * Sized by the hourly pass, which dominates every other schedule: its
   * catalog poller refreshes the whole live catalog over the network, and its
   * cadence siblings run alongside it under one `Promise.all`. The poller's
   * fleet-spreading start delay is bound only in production (`cronEntriesFor`
   * in `apps/api/src/scheduled.ts`), so a fire waits on that work and nothing
   * else. The budget keeps a wide margin over it for a saturated host and
   * stays under the per-test timeout the spec raises to, so a fire that
   * overruns fails on this budget and names the schedule rather than timing
   * the test out.
   */
  CRON_FIRE: 150_000,
  /** A single web-first assertion. */
  ASSERT: 10_000,
  /** A fast, near-immediate expectation. */
  QUICK: 1000,
  /** A long-running flow. */
  LONG: 60_000,
  /** An extra-long-running flow. */
  XLONG: 120_000,
  /** The longest sanctioned flow. */
  XXLONG: 180_000,
} as const;

/**
 * Budgets for the API liveness watchdog, which probes the API worker's static
 * `/health` route across a run and aborts the run once it stops answering.
 *
 * Fixed literals for the same reason every budget in this module is one: a
 * watchdog whose trip window stretched with load would go quiet exactly when
 * the host is saturated, which is when a dead worker is most likely.
 *
 * They sit beside `TIMEOUTS` rather than inside it because that object is
 * milliseconds-only, the currency of a `timeout:` option, and the trip count is
 * neither.
 *
 * Sizing: a worker recycle the suite is designed to survive settles inside
 * `TIMEOUTS.API_SETUP` (15s), the sanctioned recovery window, so a trip window
 * has to be wider than that to avoid killing runs that would have recovered.
 * These values put it there from both ends: samples that fail fast are spaced a
 * cadence apart, so a trip needs 20s of a static route answering nothing, and
 * samples that hang consume their whole budget, so a trip takes up to 30s. Both
 * clear the recovery window, and the wider end matches
 * `TIMEOUTS.STREAM_SATURATED` — the widest budget the suite grants a saturated
 * host for a *real* operation. A static JSON route that misses that bar is not
 * slow, it is gone.
 */
export const API_LIVENESS = {
  /**
   * How long one probe waits before abandoning the request. It must abandon:
   * a failing sample need not fail fast — wrangler's proxy holds a GET it means
   * to retry, and a stalled worker answers nothing at all — so a probe without
   * its own deadline waits instead of recording a failure.
   */
  PROBE_TIMEOUT: 10_000,
  /**
   * The period between probe starts. A probe that consumes the whole period is
   * followed immediately by the next, so the trip window stays bounded by
   * `TRIP_FAILURES` periods whether samples fail fast or hang.
   */
  PROBE_CADENCE: 10_000,
  /** Consecutive failed samples that trip the abort. Any 200 resets the count. */
  TRIP_FAILURES: 3,
} as const;
