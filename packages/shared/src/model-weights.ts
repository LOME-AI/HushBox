import type { TtsVoice } from './schemas/accessibility-preferences.ts';

/**
 * The contract between whoever publishes the on-device model artifacts, the
 * route that serves them and the loaders that fetch them. All three have to
 * name the same addresses or every fetch answers 404, and the feature they
 * serve degrades silently by design — so nothing reports the mismatch.
 *
 * Every value here is one PATH SEGMENT. The serving route reads `:model`,
 * `:version` and `:file` as single segments and refuses anything carrying a
 * separator, so an org-prefixed Hub id (`onnx-community/SmolLM2-135M-Instruct-ONNX`)
 * or a Hub-nested path (`onnx/model_int8.onnx`) addresses nothing; the names
 * below are the flattened forms.
 */

/** Bounds the object key a caller can address, and so the key the route builds. */
const SEGMENT_MAX = 128;

/**
 * One path segment of an artifact key, as an ALLOWLIST: alphanumeric first
 * character, then alphanumerics, dot, underscore and dash. Every escape shape is
 * refused by what the set omits rather than by a list of forbidden inputs — `/`,
 * `\` and `%` are simply not members, so a decoded `../secret`, a decoded
 * `/etc/passwd`, a nested `onnx/model.onnx` and a still-encoded `..%2Fsecret` all
 * fail one rule.
 *
 * The leading-character rule is what refuses `..` and `.hidden` outright; the
 * `..` check refuses a parent-directory hop anywhere later in the name, which the
 * character set alone would admit inside `model..onnx`.
 */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Whether a path segment is one the model-weights route will serve, and so one a
 * publisher may write. The route validates untrusted caller input through this
 * and the publisher predicts the route's answer with it: two spellings of the
 * rule would let a tightened route silently 404 every object published under the
 * looser one, and the feature those objects serve is built to fail without a
 * sound.
 */
export function isFetchableSegment(segment: string): boolean {
  return segment.length <= SEGMENT_MAX && SEGMENT.test(segment) && !segment.includes('..');
}

/**
 * The segment naming one published artifact set. The route serves these objects
 * `immutable`, so bytes under a published key are never rewritten: changing any
 * name below means bumping this and republishing under the new segment, never
 * re-uploading over the old one.
 */
export const MODEL_WEIGHTS_VERSION = '1';

/** The sentence-completion model. */
export const PREDICTION_MODEL_ID = 'smollm2-135m-instruct';

/** The speech model. */
export const TTS_MODEL_ID = 'kokoro-82m';

/**
 * The prediction model's objects. `generation_config.json` is requested for a
 * decoder-only model even though the loader tolerates its absence; publishing
 * it spares every session a 404.
 */
export const PREDICTION_MODEL_FILES = {
  weights: 'model_int8.onnx',
  config: 'config.json',
  generationConfig: 'generation_config.json',
  tokenizer: 'tokenizer.json',
  tokenizerConfig: 'tokenizer_config.json',
} as const;

/** The speech model's objects, excluding the per-voice blobs. */
export const TTS_MODEL_FILES = {
  weights: 'model_quantized.onnx',
  config: 'config.json',
  tokenizer: 'tokenizer.json',
  tokenizerConfig: 'tokenizer_config.json',
} as const;

/**
 * The object holding one voice's weights, flattened from the Hub's
 * `voices/<voice>.bin`.
 */
export function ttsVoiceFileName(voice: TtsVoice): string {
  return `${voice}.bin`;
}

/**
 * The object key one artifact rests at. The version sits inside the key rather
 * than beside it, so a published object is never rewritten and the immutable
 * cache declaration on the serving route is honest.
 */
export function modelWeightsObjectKey(model: string, version: string, file: string): string {
  return `models/${model}/${version}/${file}`;
}

/**
 * The origin-relative URL one artifact is served at. The path shape belongs to
 * the serving route, and a loader that spells it out itself answers 404 for the
 * life of a version the day the route moves — silently, because the features
 * these objects serve degrade without a sound. Callers prepend their API origin;
 * the origin is configuration, the shape is contract.
 */
export function modelWeightsRoutePath(model: string, version: string, file: string): string {
  return `/models/${model}/${version}/${file}`;
}
