/**
 * Message protocol between the main thread and the prediction worker.
 *
 * Every request carries a `requestId` so an answer can be matched to the call
 * that asked for it: the worker keeps one model session and answers strictly in
 * order, but the main thread abandons requests the user has typed past, and a
 * late answer must be identifiable as stale rather than applied.
 *
 * A `failed` says this worker will not serve that request, and by itself says
 * nothing about the worker's health. Two of them leave a working session
 * running: a `predict` sent when no `init` has been posted at all, and a second
 * `init` while a session is live. Terminating on either would throw away a
 * healthy worker and re-download the weights for nothing, so a caller keeps the
 * worker on those two and terminates on any other `failed`. Nothing a consumer
 * may branch on distinguishes the cases — the `reason` below is prose for a
 * human, not a discriminant — so the caller decides from what it asked for and
 * whether it has posted an `init` at all.
 *
 * A `predict` posted while an `init` is still in flight is not one of the two.
 * Messages are answered in arrival order, so that `predict` is dispatched only
 * once the `init` has settled; if it then comes back `failed` for want of a
 * session, the `init` itself failed — which is the terminal case.
 *
 * Every other failure has already disposed the session before the `failed` is
 * posted: a failed `OrtRun` leaves the ONNX session wedged for good, so the
 * worker refuses all later work — including a further `init` — and the only
 * recovery is the main thread terminating it and spawning another.
 *
 * A `failed` also carries a `reason`. No consumer branches on it and nothing
 * displays or logs it — the feature degrades without a sound, which is the
 * design — but a worker that gives up otherwise says nothing at all about why,
 * and reconstructing that from the outside costs a day. Whoever is debugging
 * reads it off the message.
 */

/**
 * The API origin artifacts are fetched from. It is configuration rather than
 * contract — the path shape comes from `@hushbox/shared/model-weights` — so it
 * is handed in rather than read here, which also keeps the worker bundle clear
 * of the app's environment plumbing.
 */
export type PredictionWorkerInbound =
  | { type: 'init'; requestId: string; apiOrigin: string }
  | {
      type: 'predict';
      requestId: string;
      text: string;
      /**
       * Rival continuations wanted beside the inline one. Zero is the surface
       * that shows no candidate list, and it is worth its own value: the
       * alternatives come from a batched sampling pass costing an order of
       * magnitude more than the cached greedy one, so asking for none is the
       * difference between a hint arriving during a typing pause and long after
       * it.
       */
      alternativeCount: number;
    };

export type PredictionWorkerOutbound =
  | { type: 'ready'; requestId: string }
  | {
      /**
       * The inline continuation, posted the moment the cached greedy pass
       * produces it. Non-terminal: it never answers the caller's request by
       * itself, because a batched `alternatives` (or a `failed`) for the same
       * `requestId` still follows.
       */
      type: 'completion';
      requestId: string;
      completion: string;
    }
  | {
      /**
       * The rival continuations, posted once the batched sampled pass
       * finishes. Terminal: the last message a `predict` produces on success.
       */
      type: 'alternatives';
      requestId: string;
      alternatives: readonly string[];
    }
  | {
      type: 'failed';
      requestId: string;
      /**
       * Why this request was refused or abandoned: a library error's message, a
       * canary mismatch naming both token sequences, or the refusal itself.
       * Never rendered, never logged, and never built from anything the user
       * typed.
       */
      reason: string;
    };

const OUTBOUND_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'completion',
  'alternatives',
  'failed',
]);

function carriesACompletion(value: object): boolean {
  return typeof (value as { completion?: unknown }).completion === 'string';
}

function carriesAlternatives(value: object): boolean {
  const alternatives = (value as { alternatives?: unknown }).alternatives;
  return Array.isArray(alternatives) && alternatives.every((one) => typeof one === 'string');
}

/**
 * Whether a value arriving over the worker boundary is one of our answers. The
 * boundary is untyped, and a prediction is spliced into text the user is about
 * to send, so the shape is checked rather than asserted.
 */
export function isPredictionWorkerOutbound(value: unknown): value is PredictionWorkerOutbound {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown; requestId?: unknown; reason?: unknown };
  if (typeof message.type !== 'string' || !OUTBOUND_TYPES.has(message.type)) return false;
  if (typeof message.requestId !== 'string') return false;
  if (message.type === 'completion') return carriesACompletion(value);
  if (message.type === 'alternatives') return carriesAlternatives(value);
  if (message.type === 'failed') {
    return typeof message.reason === 'string';
  }
  return true;
}
