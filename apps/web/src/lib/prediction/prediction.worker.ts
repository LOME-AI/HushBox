// Dedicated Web Worker hosting the sentence-completion model and its
// @huggingface/transformers + onnxruntime-web runtime. One session, one thread:
// the composer's inline hint and its candidate list both come from here, and a
// second resident copy of the weights is exactly what this feature must not
// cost a phone.
//
// The handler logic is exported as `createPredictionWorkerHandler(ctx)` so tests
// can drive it without spawning a worker or loading weights. The worker globals
// are wired at module bottom, guarded so the test environment does not register
// a top-level listener.
//
// The worker is built as an ES module (`WORKER_BUILD_OPTIONS` in the shared
// build config, applied by the app's Vite config): the classic-worker wrapper
// corrupts `new.target`, which the transformers class hierarchy depends on.

import { AutoModelForCausalLM, AutoTokenizer, Tensor, env, ones } from '@huggingface/transformers';

import { ORT_WASM_PATH } from '@hushbox/shared';
import {
  MODEL_WEIGHTS_VERSION,
  PREDICTION_MODEL_FILES,
  PREDICTION_MODEL_ID,
  modelWeightsRoutePath,
} from '@hushbox/shared/model-weights';

import { cappedPredictionInput } from './prediction-input-cap';
import { healCompletion, healPromptBoundary } from './prompt-boundary';
import type {
  PredictionWorkerInbound,
  PredictionWorkerOutbound,
} from './prediction-worker-protocol';

/**
 * The standard export at int8, which is one self-contained file with no
 * external-data sidecar. `q4f16` does not execute on the wasm backend at all,
 * and the `-MHA` fork cannot prefill several tokens in one pass — the whole
 * basis of continuing a sentence while it is still being typed.
 */
const DTYPE = 'int8' as const;
const DEVICE = 'wasm' as const;

/**
 * The stem the library builds its weights request from: it asks for
 * `<stem><dtype suffix>.onnx`, while the shared contract publishes the whole
 * name, so the two are reconciled here. A drift between them is a 404 nothing
 * reports, which is why the reconciliation is asserted by a test rather than
 * left to agree by coincidence.
 */
const WEIGHTS_FILE_STEM = PREDICTION_MODEL_FILES.weights.slice(0, -`_${DTYPE}.onnx`.length);

/** Tokens of hint. Past a dozen the tail is trimmed away by shaping anyway. */
const MAX_NEW_TOKENS = 12;

/**
 * The canary input and the tokens greedily produced from it. The pin is per
 * (export, dtype, ORT build): the same export at the same dtype, through the
 * same library and settings on onnxruntime-node's CPU provider, diverges from
 * these at the seventh token. Re-measuring them is therefore a step of any
 * onnxruntime-web bump exactly as much as of a model change — an upgrade that
 * skips it flips the canary to a mismatch and takes the feature inert for every
 * user, silently, and no test would catch that.
 *
 * It guards the failure mode no error path catches — a wasm SIMD miscompile
 * that returns wrong numbers rather than throwing, historically on the iOS
 * versions this app still targets. Chromium, Firefox and WebKit produce these
 * tokens identically and repeatably, which is largely structural: all three run
 * the one self-hosted ORT binary single-threaded. That agreement is evidence
 * about an engine-specific miscompile, not about a change of runtime.
 *
 * The ids are pinned as Numbers and retyped here because that is what they are
 * compared against: see {@link tokenRows}. The values are the pin.
 */
export const CANARY_INPUT = 'The capital city of France is called';
export const CANARY_EXPECTED_TOKENS: readonly bigint[] = [
  7042, 30, 7042, 314, 253, 1739, 2240, 281,
].map(BigInt);

/**
 * A tensor of token ids as the library returns one. `tolist()` is typed `any[]`
 * upstream and its element type is decided by the tensor's dtype rather than by
 * the caller, so what it lists is read through {@link tokenRows} rather than
 * declared here.
 */
interface TokenTensor {
  tolist(): unknown;
}

function isBigIntRow(value: unknown): value is bigint[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'bigint');
}

function isTokenRows(value: unknown): value is bigint[][] {
  return Array.isArray(value) && value.every((row) => isBigIntRow(row));
}

/**
 * The rows of token ids a tensor lists.
 *
 * Token ids are `int64` everywhere in this library — the tokenizer's
 * `input_ids` and `generate`'s `sequences` alike — so every row lists BigInt.
 * Reading them as `number` type-checks, runs, and silently loses every `===`
 * against a BigInt, which would take the canary and every completion inert
 * without an error; requiring the dtype here is what makes that a failure the
 * worker reports instead.
 */
function tokenRows(tensor: TokenTensor): bigint[][] {
  const rows: unknown = tensor.tolist();
  if (!isTokenRows(rows)) {
    throw new Error('a token tensor did not list rows of BigInt token ids');
  }
  return rows;
}

interface Encoding {
  input_ids: TokenTensor;
}

interface Tokenizer {
  (text: string, options: { add_special_tokens: boolean }): Encoding;
  decode(ids: bigint[], options: { skip_special_tokens: boolean }): string;
}

function isTokenizer(value: unknown): value is Tokenizer {
  return typeof value === 'function' && 'decode' in value && typeof value.decode === 'function';
}

interface GenerationOutput {
  sequences: TokenTensor;
  past_key_values: unknown;
}

interface CausalModel {
  generate(args: Record<string, unknown>): Promise<GenerationOutput>;
  dispose(): Promise<unknown>;
}

// A loaded model is a callable: the library's model base class extends its
// `Callable`, whose constructor returns a function closure, so an instance
// reports `typeof 'function'` and never `'object'`.
function isCausalModel(value: unknown): value is CausalModel {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'generate' in value &&
    typeof value.generate === 'function' &&
    'dispose' in value &&
    typeof value.dispose === 'function'
  );
}

/** A loaded model and the tokenizer that feeds it; they only ever exist together. */
interface Session {
  readonly tokenizer: Tokenizer;
  readonly model: CausalModel;
}

interface GenerateOptions {
  readonly batch: number;
  readonly maxNewTokens: number;
  readonly sample: boolean;
  readonly keyValues: unknown;
}

export interface PredictionWorkerContext {
  postMessage(message: PredictionWorkerOutbound): void;
}

function idsTensor(ids: readonly bigint[], batch: number): Tensor {
  const flat: bigint[] = [];
  for (let copy = 0; copy < batch; copy++) flat.push(...ids);
  return new Tensor('int64', BigInt64Array.from(flat), [batch, ids.length]);
}

/**
 * Why a request failed, for the `failed` message to carry. Never logged and
 * never shown — the feature degrades in silence by design — so this is the only
 * account a worker that gave up ever gives of itself, and it is read off the
 * message by whoever is debugging.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPrefix(candidate: readonly bigint[], of: readonly bigint[]): boolean {
  return candidate.length <= of.length && candidate.every((id, index) => id === of[index]);
}

/**
 * The one row of a batch-of-one result. Flattening rather than indexing: there
 * is exactly one row, and an index would demand a fallback that can never run.
 */
function onlyRow(rows: bigint[][]): bigint[] {
  return rows.flat();
}

function tokenize(session: Session, text: string): bigint[] {
  return onlyRow(tokenRows(session.tokenizer(text, { add_special_tokens: false }).input_ids));
}

function decode(session: Session, ids: bigint[]): string {
  return session.tokenizer.decode(ids, { skip_special_tokens: true });
}

async function generate(
  session: Session,
  ids: readonly bigint[],
  options: GenerateOptions
): Promise<GenerationOutput> {
  const args: Record<string, unknown> = {
    input_ids: idsTensor(ids, options.batch),
    attention_mask: ones([options.batch, ids.length]),
    max_new_tokens: options.maxNewTokens,
    do_sample: options.sample,
    return_dict_in_generate: true,
  };
  // No `repetition_penalty`: measured on this export at this dtype it cost 6
  // points of next-word accuracy and a fifth of the decode rate to remove 1.5
  // points of degenerate output, which an instruct-tuned model barely produces.
  // It earns its place on the base export, not this one.
  if (options.keyValues !== null) args['past_key_values'] = options.keyValues;
  return await session.model.generate(args);
}

export function createPredictionWorkerHandler(
  ctx: PredictionWorkerContext
): (message: PredictionWorkerInbound) => Promise<void> {
  let session: Session | null = null;
  // Set the moment anything fails. A failed OrtRun wedges the session for good,
  // so recovery is the main thread terminating this worker and spawning a fresh
  // one; reloading or retrying here would run against a runtime that can no
  // longer be trusted to answer.
  let wedged = false;
  // Serializes generations: one ONNX session invoked concurrently is undefined
  // behaviour, and the main thread is free to send a second request while the
  // first is still running.
  let chain: Promise<void> = Promise.resolve();

  // The typed prefix the cache covers, one token short of the text it was built
  // for. The library prefills only `input_ids` past the cache's length, so a
  // cache as long as the text it is passed with would be read as covering
  // nothing and the whole prompt re-run.
  let cachedIds: bigint[] = [];
  let cachedKeyValues: unknown = null;

  async function disposeSession(): Promise<void> {
    wedged = true;
    cachedIds = [];
    cachedKeyValues = null;
    const disposing = session;
    session = null;
    if (disposing === null) return;
    try {
      await disposing.model.dispose();
    } catch {
      // Disposal is least trustworthy on the path that reaches it — a runtime a
      // failed OrtRun has already wedged — and the state this worker owns is
      // safe either way, set above before the await. Letting the throw out
      // would instead lose the `failed` its caller posts next, and with it every
      // later answer: the messages are serialized, so a rejection here leaves
      // the chain rejected and every subsequent request unanswered.
    }
  }

  /**
   * Advances the cache to cover `ids`, prefilling only what it does not already
   * hold. Reuse is append-only by construction: a mid-string edit leaves the
   * cached prefix un-matching and the prompt is prefilled whole, which is the
   * expected cost of editing rather than a case to engineer around.
   */
  async function advanceCache(current: Session, ids: readonly bigint[]): Promise<unknown> {
    if (ids.length === 0) return null;
    const reusable = cachedKeyValues !== null && isPrefix(cachedIds, ids);
    if (reusable && cachedIds.length === ids.length) return cachedKeyValues;
    const output = await generate(current, ids, {
      batch: 1,
      maxNewTokens: 1,
      sample: false,
      keyValues: reusable ? cachedKeyValues : null,
    });
    return output.past_key_values;
  }

  async function runPredict(
    current: Session,
    requestId: string,
    text: string,
    alternativeCount: number
  ): Promise<void> {
    // Bounded here, ahead of tokenization: the KV cache this session builds
    // from the result is this worker's own memory to protect, and every
    // caller of `predict` — present and future — reaches this same guard.
    const { text: healedText, healedTrailingSpace } = healPromptBoundary(
      cappedPredictionInput(text)
    );
    const ids = tokenize(current, healedText);
    if (ids.length === 0) {
      ctx.postMessage({ type: 'completion', requestId, completion: '' });
      ctx.postMessage({ type: 'alternatives', requestId, alternatives: [] });
      return;
    }

    const prefix = ids.slice(0, -1);
    const keyValues = await advanceCache(current, prefix);
    cachedIds = prefix;
    cachedKeyValues = keyValues;

    const inline = await generate(current, ids, {
      batch: 1,
      maxNewTokens: MAX_NEW_TOKENS,
      sample: false,
      keyValues,
    });
    const completion = healCompletion(
      decode(current, onlyRow(tokenRows(inline.sequences)).slice(ids.length)),
      healedTrailingSpace
    );
    // Posted the moment it exists rather than held back until the alternatives
    // finish: the caret hint is what a reader is waiting on, and it is already
    // computed here while the (several times costlier) batched sampling pass
    // has not even started.
    ctx.postMessage({ type: 'completion', requestId, completion });

    // One batched sampled pass rather than several calls: beam search does not
    // exist in this library version, and sampling several copies of the same
    // prompt in one generation is what makes a list affordable at all.
    let alternatives: string[] = [];
    if (alternativeCount > 0) {
      const sampled = await generate(current, ids, {
        batch: alternativeCount,
        maxNewTokens: MAX_NEW_TOKENS,
        sample: true,
        keyValues: null,
      });
      // Only the inline continuation is filtered out, which the seam requires.
      // Rival rows repeating each other are collapsed downstream, where the
      // shaping that can make two different raw answers identical happens.
      // Every alternative goes through the same boundary heal as the inline
      // completion — the trailing space it is answering did not become less
      // real because this is the sampled pass rather than the greedy one.
      alternatives = tokenRows(sampled.sequences)
        .map((row) => healCompletion(decode(current, row.slice(ids.length)), healedTrailingSpace))
        .filter((candidate) => candidate !== completion);
    }

    ctx.postMessage({ type: 'alternatives', requestId, alternatives });
  }

  async function runCanary(current: Session): Promise<void> {
    const ids = tokenize(current, CANARY_INPUT);
    const output = await generate(current, ids, {
      batch: 1,
      maxNewTokens: CANARY_EXPECTED_TOKENS.length,
      sample: false,
      keyValues: null,
    });
    const produced = onlyRow(tokenRows(output.sequences)).slice(ids.length);
    const matches =
      produced.length === CANARY_EXPECTED_TOKENS.length &&
      produced.every((token, index) => token === CANARY_EXPECTED_TOKENS[index]);
    if (!matches) {
      throw new Error(
        `canary token mismatch: produced [${produced.join(', ')}], expected [${CANARY_EXPECTED_TOKENS.join(', ')}]`
      );
    }
  }

  async function handleInit(requestId: string, apiOrigin: string): Promise<void> {
    if (wedged) {
      ctx.postMessage({
        type: 'failed',
        requestId,
        reason: 'the runtime is wedged and cannot be reloaded',
      });
      return;
    }
    if (session !== null) {
      ctx.postMessage({ type: 'failed', requestId, reason: 'a session is already loaded' });
      return;
    }
    try {
      // Same-origin ONNX runtime: the library's default points its wasm at a
      // third-party CDN, which the deployed policy does not admit. The section
      // has to be mutated rather than replaced — it is onnxruntime-web's own
      // live `env`, not a plain object — and the library types it as a
      // `Partial`, while the runtime always creates it (grounded by a test).
      const ortWasm = env.backends.onnx.wasm as { wasmPaths: string };
      ortWasm.wasmPaths = ORT_WASM_PATH;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      env.remoteHost = apiOrigin;
      // `{model}` is the library's own placeholder, filled with the id passed to
      // `from_pretrained`. Building the template through the shared path builder
      // is what keeps the loader addressing the route the publisher wrote to.
      env.remotePathTemplate = modelWeightsRoutePath('{model}', MODEL_WEIGHTS_VERSION, '');

      const tokenizer: unknown = await AutoTokenizer.from_pretrained(PREDICTION_MODEL_ID);
      if (!isTokenizer(tokenizer)) {
        throw new Error('the loaded tokenizer cannot be called or cannot decode');
      }
      const model: unknown = await AutoModelForCausalLM.from_pretrained(PREDICTION_MODEL_ID, {
        dtype: DTYPE,
        device: DEVICE,
        // The artifacts are published under flat names; the library's default
        // `onnx` subfolder would address a nested key the serving route reads
        // as a second path segment and refuses.
        subfolder: '',
        model_file_name: WEIGHTS_FILE_STEM,
      });
      if (!isCausalModel(model)) {
        throw new Error('the loaded model cannot generate or dispose');
      }
      session = { tokenizer, model };

      await runCanary(session);
      ctx.postMessage({ type: 'ready', requestId });
    } catch (error) {
      await disposeSession();
      ctx.postMessage({ type: 'failed', requestId, reason: reasonOf(error) });
    }
  }

  async function handlePredict(
    requestId: string,
    text: string,
    alternativeCount: number
  ): Promise<void> {
    const current = session;
    if (current === null) {
      ctx.postMessage({ type: 'failed', requestId, reason: 'no session is loaded' });
      return;
    }
    try {
      await runPredict(current, requestId, text, alternativeCount);
    } catch (error) {
      await disposeSession();
      ctx.postMessage({ type: 'failed', requestId, reason: reasonOf(error) });
    }
  }

  async function dispatch(message: PredictionWorkerInbound): Promise<void> {
    if (message.type === 'init') {
      await handleInit(message.requestId, message.apiOrigin);
      return;
    }
    await handlePredict(message.requestId, message.text, message.alternativeCount);
  }

  return async function handleMessage(message: PredictionWorkerInbound): Promise<void> {
    // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- explicit chain: appending preserves arrival order without awaiting, and the async callback's implicit return is a Promise<void>
    const queued = chain.then(async () => {
      await dispatch(message);
    });
    chain = queued;
    await queued;
  };
}

// Auto-register the listener only inside a real dedicated worker.
// `importScripts` is worker-only and undefined under vitest, which keeps tests
// from installing a global handler.
declare const importScripts: unknown;
if (typeof importScripts === 'function') {
  const ctx: PredictionWorkerContext = {
    postMessage(message) {
      self.postMessage(message);
    },
  };
  const handler = createPredictionWorkerHandler(ctx);
  // eslint-disable-next-line sonarjs/post-message -- a dedicated worker receives messages only from the same-origin parent that created it
  self.addEventListener('message', (event: MessageEvent) => {
    void handler((event as MessageEvent<PredictionWorkerInbound>).data);
  });
}
