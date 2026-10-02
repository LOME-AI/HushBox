/**
 * The seam between the composer and whatever produces sentence completions.
 *
 * Everything downstream of this interface is pure: shaping, the state machine
 * and the gesture rules never learn which implementation is behind it. That is
 * what lets the whole feature be tested without a model — a synchronous fake
 * satisfies this contract exactly as a worker-backed adapter does.
 */

/** One predictor answer: the continuation to inline, plus rival continuations. */
export interface Prediction {
  /** The continuation to render directly after the typed text. */
  readonly completion: string;
  /** Further continuations for the candidate list. Never includes `completion`. */
  readonly alternatives: readonly string[];
}

export interface PromptPredictor {
  /**
   * Continues `text`. Rejects when `signal` aborts, and may reject for any
   * other reason: prediction is a best-effort hint, so a caller treats every
   * rejection as "no prediction" and shows the user nothing.
   *
   * `onCompletion` fires once, as soon as `completion` is known — strictly
   * before this promise settles — so a caller can render the inline text
   * without waiting on the alternatives that follow it.
   */
  predict(
    text: string,
    signal: AbortSignal,
    onCompletion: (completion: string) => void
  ): Promise<Prediction>;
  /**
   * Notifies `listener` every time this predictor becomes able to answer
   * after having rejected because it was not ready yet. Returns an
   * unsubscribe function. A predictor that can never reject for that reason
   * omits it.
   */
  readonly onReady?: (listener: () => void) => () => void;
}
