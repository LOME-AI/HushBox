import { Network } from '@capacitor/network';
import { isNative } from '@/capacitor/platform';
import { getApiUrl } from '@/lib/api/api';
import { isPredictionWorkerOutbound } from './prediction-worker-protocol';
import type {
  PredictionWorkerInbound,
  PredictionWorkerOutbound,
} from './prediction-worker-protocol';
import type { Prediction } from './predictor';

/**
 * The one sentence-completion session the whole app shares.
 *
 * Module state rather than a per-component instance on purpose: the weights are
 * ~135 MB and a second resident copy is what this feature must never cost a
 * phone, so both composer surfaces and every mount of them reach the same
 * worker. Nothing here is built until a composer actually asks for a
 * prediction — the load is not on any page's critical path, and this module
 * reaches the worker only through `new URL(…, import.meta.url)`, which the
 * bundler emits as a separate chunk rather than pulling the inference library
 * into the app bundle.
 *
 * Every failure is silent. There is no toast, no console line and no error
 * reporting: a user whose model never arrives sees the composer that existed
 * before this feature did.
 */

/** How long a failed load keeps the feature off, counted from the failure. */
const LOAD_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Where the backoff deadline rests. It has to outlive the page: a broken origin
 * or a wedged runtime that is re-attempted on every visit re-pulls the weights
 * every visit, and nothing tells the user or us that it is happening.
 */
const BACKOFF_STORAGE_KEY = 'hushbox.prediction.load-backoff-until';

/**
 * The connection type the download is allowed over. It is the only one the
 * platform reports as unmetered, so every other answer — a metered cellular
 * link, no link, or a link it cannot classify — withholds a ~135 MB transfer
 * the user never asked for.
 */
const UNMETERED_CONNECTION = 'wifi';

type WorkerFactory = () => Worker;

/** Answers one request, whatever the worker said about it. */
type Settle = (message: PredictionWorkerOutbound) => void;

/* v8 ignore start */
// Constructs the real module worker, which no test environment can load; tests
// always inject one through {@link _setPredictionWorkerFactoryForTesting}.
function defaultWorkerFactory(): Worker {
  // Vite emits a worker referenced this way as its own chunk, which is what
  // keeps the inference library out of the app bundle. `type: 'module'` says
  // how the browser loads that chunk; the format it is built in comes from the
  // app's `worker.format` build option, which must stay `es` — the classic
  // wrapper rewrites `new.target` and the transformers class hierarchy dies.
  return new Worker(new URL('prediction.worker.ts', import.meta.url), { type: 'module' });
}
/* v8 ignore stop */

let buildWorker: WorkerFactory = defaultWorkerFactory;

/** Test-only: build fake workers instead of loading a real model. */
export function _setPredictionWorkerFactoryForTesting(factory: WorkerFactory | null): void {
  buildWorker = factory ?? defaultWorkerFactory;
}

let worker: Worker | null = null;
/** Whether the live worker has answered its load. */
let ready = false;
/** Whether a load is in flight; one attempt is allowed to be outstanding. */
let loading = false;
/** Whether this page session has given up for good. */
let unavailable = false;
/** Whether this page session has already replaced a wedged runtime once. */
let replaced = false;
let nextRequest = 0;
const pending = new Map<string, Settle>();
/** The persisted deadline, read once per page session. */
let backoffUntil: number | null = null;
/**
 * Counts the sessions thrown away, so a load still waiting on an answer can
 * tell that the session it is building has already been dropped. Disposal is
 * synchronous and the connection question is not — on native it crosses the
 * bridge — so a backgrounded app can dispose between the question and the
 * answer, and the resumed load would otherwise hold ~135 MB that nothing is
 * left to release.
 */
let dropped = 0;
/** Listeners waiting on the session's next not-ready-to-ready transition. */
const readyListeners = new Set<() => void>();

function readBackoffDeadline(): number {
  try {
    const stored = Number(globalThis.localStorage.getItem(BACKOFF_STORAGE_KEY));
    return Number.isFinite(stored) ? stored : 0;
  } catch {
    // Storage a browser refuses to read is not a reason to withhold the
    // feature; it only means this visit cannot remember a previous failure.
    return 0;
  }
}

function recordBackoff(): void {
  const deadline = Date.now() + LOAD_BACKOFF_MS;
  backoffUntil = deadline;
  try {
    globalThis.localStorage.setItem(BACKOFF_STORAGE_KEY, String(deadline));
  } catch {
    // The refusal costs the next visit a retry, and nothing else.
  }
}

function withinBackoff(): boolean {
  backoffUntil ??= readBackoffDeadline();
  return Date.now() < backoffUntil;
}

/**
 * Whether handing a composer a predictor is worth anything. A composer given
 * none behaves exactly as it did before this feature existed, which is the
 * answer for every case where no model is going to arrive.
 */
export function predictionSessionOffered(): boolean {
  return !unavailable && !withinBackoff();
}

/**
 * Notifies `listener` every time the shared session finishes loading. A
 * composer that asked while the session was still loading got nothing back
 * from that call — this is how it learns the session can now answer, so it
 * can ask again for whatever text it is still holding. Returns an unsubscribe
 * function.
 */
export function subscribePredictionSessionReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

function notifyReady(): void {
  for (const listener of readyListeners) listener();
}

/** Answers every outstanding request as failed and drops the worker. */
function teardown(): void {
  dropped += 1;
  loading = false;
  ready = false;
  worker?.terminate();
  worker = null;
  const abandoned = [...pending.values()];
  pending.clear();
  for (const settle of abandoned) {
    settle({
      type: 'failed',
      requestId: '',
      reason: 'session torn down before this request completed',
    });
  }
}

/**
 * Gives up for the rest of this page session and remembers it for the next.
 *
 * This is the answer for a load that never reached `ready`: the artifacts could
 * not be fetched or did not validate, and re-attempting that on every visit
 * re-pulls ~135 MB from an origin that has just proved broken.
 */
function abandonSession(): void {
  recordBackoff();
  unavailable = true;
  teardown();
}

/**
 * Routes a terminal failure by the class it belongs to.
 *
 * A failure once the model has loaded is a wedged ONNX session. It never
 * recovers in place, so the worker is thrown away rather than reset, but it
 * does recover by replacement: the weights are served immutable, so the next
 * worker re-reads them from the HTTP cache rather than the network. One
 * replacement per page session bounds that; a second wedge leaves the feature
 * off. Neither writes the cross-visit backoff, which answers artifacts that
 * could not be loaded at all.
 */
function handleTerminalFailure(): void {
  if (!ready) {
    abandonSession();
    return;
  }
  if (replaced) unavailable = true;
  replaced = true;
  teardown();
}

/**
 * Routes one worker message, but only for the generation that posted it. A
 * disposed worker's already-queued task can still fire after a newer load has
 * taken over — teardown does not unwind an in-flight browser task — so an
 * event carrying a superseded generation is dropped rather than acted on: it
 * belongs to a worker this module has already stopped answering for.
 */
function handleMessage(generation: number, event: MessageEvent): void {
  if (dropped !== generation) return;
  const data: unknown = event.data;
  if (!isPredictionWorkerOutbound(data)) return;
  const settle = pending.get(data.requestId);
  // `completion` is the one non-terminal outbound type: a `predict` request
  // stays pending after it, answered next by `alternatives` (or `failed`).
  // Every other type answers whatever request it names, so this is the only
  // branch that keeps the pending entry rather than deleting it.
  if (data.type !== 'completion') pending.delete(data.requestId);
  settle?.(data);
  // Every `failed` this module can receive is terminal, because it never sends
  // either message that would earn a survivable one: it posts no `predict`
  // before a `ready`, and no second `init` while a session is live.
  if (data.type === 'failed') handleTerminalFailure();
}

/** Routes a worker's `error` event for the generation that built it; see {@link handleMessage}. */
function handleWorkerFailure(generation: number): void {
  if (dropped !== generation) return;
  handleTerminalFailure();
}

async function connectionAllowsDownload(): Promise<boolean> {
  if (!isNative()) return true;
  const status = await Network.getStatus();
  return status.connectionType === UNMETERED_CONNECTION;
}

function post(target: Worker, message: PredictionWorkerInbound, settle: Settle): void {
  pending.set(message.requestId, settle);
  target.postMessage(message);
}

function newRequestId(): string {
  nextRequest += 1;
  return String(nextRequest);
}

/**
 * What a load has decided to do about the state of the world it found. A value,
 * not an effect: deciding is asynchronous and therefore droppable, so nothing
 * on the deciding side is allowed to act.
 */
type LoadOutcome = 'start' | 'withhold' | 'abandon';

/** Decides an outcome, touching no module state to reach it. */
async function planLoad(): Promise<LoadOutcome> {
  try {
    return (await connectionAllowsDownload()) ? 'start' : 'withhold';
  } catch {
    return 'abandon';
  }
}

/**
 * Applies what a load decided, if that load is still the current one.
 *
 * The load path writes module state only through this function, and only once
 * its generation check has passed, which is what makes a continuation belonging
 * to a dropped load inert whatever it decided: an outcome added later inherits
 * the check, so reopening this can only mean deleting the check rather than
 * forgetting to repeat it. A dropped load reaching here is the ordinary case
 * rather than a rare interleaving — backgrounding the app is both what drops
 * the session and what makes the native connection question fail — and the
 * teardown that dropped it has already reset the state a later engagement
 * starts from.
 */
function commitLoad(startedAt: number, outcome: LoadOutcome): void {
  if (dropped !== startedAt) return;
  if (outcome === 'withhold') {
    // Nothing failed and nothing is owed a backoff: the next engagement over an
    // unmetered connection loads exactly as a first one would.
    loading = false;
    return;
  }
  if (outcome === 'abandon') {
    abandonSession();
    return;
  }
  try {
    const created = buildWorker();
    worker = created;
    created.addEventListener('message', (event: MessageEvent) => {
      handleMessage(startedAt, event);
    });
    created.addEventListener('error', () => {
      handleWorkerFailure(startedAt);
    });
    post(
      created,
      { type: 'init', requestId: newRequestId(), apiOrigin: getApiUrl() },
      (message) => {
        if (message.type !== 'ready') return;
        ready = true;
        loading = false;
        notifyReady();
      }
    );
  } catch {
    // A worker the environment refuses to construct is a load that never
    // reached ready, which is the class the cross-visit backoff answers.
    abandonSession();
  }
}

async function openSession(): Promise<void> {
  const startedAt = dropped;
  commitLoad(startedAt, await planLoad());
}

function beginLoad(): void {
  if (loading || unavailable || worker !== null || withinBackoff()) return;
  loading = true;
  void openSession();
}

/**
 * Continues `text` on the shared session, starting that session if this is the
 * first time a composer has asked.
 *
 * Rejection is the whole vocabulary for "no prediction": loading, withheld,
 * abandoned and aborted all reject, so no caller has to learn a loading state
 * and none of them ever waits on one.
 *
 * `onCompletion` fires once, as soon as the worker's `completion` message
 * arrives — well before this promise settles — so a caller can show the inline
 * hint immediately rather than waiting on the costlier batched alternatives.
 * The returned promise still resolves only once both phases have landed.
 */
export function predictWithSharedSession(
  text: string,
  alternativeCount: number,
  signal: AbortSignal,
  onCompletion: (completion: string) => void
): Promise<Prediction> {
  const active = ready ? worker : null;
  if (active === null) {
    beginLoad();
    return Promise.reject(new Error('prediction session is not ready'));
  }
  if (signal.aborted) return Promise.reject(new Error('prediction aborted'));

  return new Promise<Prediction>((resolve, reject) => {
    const requestId = newRequestId();
    let completion: string | null = null;
    const abort = (): void => {
      pending.delete(requestId);
      reject(new Error('prediction aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    post(active, { type: 'predict', requestId, text, alternativeCount }, (message) => {
      if (message.type === 'completion') {
        completion = message.completion;
        onCompletion(message.completion);
        return;
      }
      signal.removeEventListener('abort', abort);
      if (message.type !== 'alternatives' || completion === null) {
        reject(new Error('prediction failed'));
        return;
      }
      resolve({ completion, alternatives: message.alternatives });
    });
  });
}

/**
 * Drops the session and its weights. The next composer engagement rebuilds one
 * under the same rules as the first — a session that had already given up stays
 * given up.
 */
export function disposePredictionSession(): void {
  teardown();
}

/** Test-only: return the module to the state a fresh page load starts in. */
export function _resetPredictionSessionForTesting(): void {
  teardown();
  unavailable = false;
  replaced = false;
  backoffUntil = null;
  nextRequest = 0;
  readyListeners.clear();
}
