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
  /** A media asset (image/video) has decoded and rendered. */
  MEDIA_DECODE: 30_000,
  /** A realtime WebSocket connection has completed its handshake. */
  WS_HANDSHAKE: 15_000,
  /** A modal/dialog has opened or closed. */
  MODAL: 5000,
  /** A scroll position has stabilized. */
  SCROLL_STABLE: 5000,
  /** An inbound webhook has been received and processed. */
  WEBHOOK: 30_000,
  /**
   * A dev/setup endpoint POST has returned a terminal (non-transient) response.
   * Bounds the retry budget for `postWithRetry`: under host saturation a
   * workerd/wrangler restart answers an in-flight request with a bare 5xx, and
   * the POST is re-issued until it settles or this budget elapses.
   */
  API_SETUP: 15_000,
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
