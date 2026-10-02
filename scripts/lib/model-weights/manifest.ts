import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { TTS_VOICE_IDS } from '@hushbox/shared';
import {
  MODEL_WEIGHTS_VERSION as ARTIFACT_SET_VERSION,
  PREDICTION_MODEL_FILES,
  PREDICTION_MODEL_ID,
  TTS_MODEL_FILES,
  TTS_MODEL_ID,
  isFetchableSegment,
  modelWeightsObjectKey,
  ttsVoiceFileName,
} from '@hushbox/shared/model-weights';

/** The Worker binding the model-weights route reads its objects through. */
const MODEL_WEIGHTS_BINDING = 'MODEL_WEIGHTS';

/** The Worker config that declares that binding, and so names its bucket. */
const API_WRANGLER_TOML = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'apps',
  'api',
  'wrangler.toml'
);

/** As much of a Worker config as naming a bucket needs. */
const r2BucketsSchema = z.object({
  r2_buckets: z.array(z.object({ binding: z.string(), bucket_name: z.string() })).default([]),
});

/**
 * The bucket a Worker config binds this script's objects to. Reading it beats
 * naming it here as well, because the drift a second spelling permits is
 * silent: a remote mismatch errors at upload, but the local R2 emulator
 * materialises a store under whatever name it is handed, so seeding would fill
 * one bucket while the binding read another and both on-device features would
 * serve 404 with nothing reporting it.
 */
export function modelWeightsBucketIn(wranglerToml: string): string {
  const bound = r2BucketsSchema
    .parse(parse(wranglerToml))
    .r2_buckets.find((entry) => entry.binding === MODEL_WEIGHTS_BINDING);
  if (bound === undefined) {
    throw new Error(
      `model weights: apps/api/wrangler.toml names no bucket for the ${MODEL_WEIGHTS_BINDING} ` +
        'binding, so there is nowhere to publish that the route can serve from'
    );
  }
  return bound.bucket_name;
}

/** The bucket every published object rests in, as the Worker itself binds it. */
export const MODEL_WEIGHTS_BUCKET = modelWeightsBucketIn(readFileSync(API_WRANGLER_TOML, 'utf8'));

/**
 * The artifact contract — the version segment, the model ids and the flat file
 * names — is published once in `@hushbox/shared` and republished here, so what
 * this script uploads and what the route serves cannot be two answers.
 */
export {
  MODEL_WEIGHTS_VERSION as ARTIFACT_SET_VERSION,
  PREDICTION_MODEL_ID,
  TTS_MODEL_ID,
} from '@hushbox/shared/model-weights';

/** One published object, and where its bytes come from. */
export interface Artifact {
  readonly model: string;
  /** The object's file name. Flat: the route reads `:file` as one path segment. */
  readonly file: string;
  /** The Hugging Face repository holding the source bytes. */
  readonly repo: string;
  /** The Hub commit the download pins, so an upstream edit cannot change what ships. */
  readonly revision: string;
  /** The path inside that repository, which may be nested even though `file` never is. */
  readonly repoPath: string;
  /**
   * The expected byte length. A pinned Hub commit already fixes the content, so
   * this guards the download rather than the source: a short read is refused
   * instead of published. A SHA-256 would bind more tightly, but neither
   * repository publishes a checksum manifest to copy one from.
   */
  readonly bytes: number;
}

const PREDICTION_REPO = 'onnx-community/SmolLM2-135M-Instruct-ONNX';
const PREDICTION_REVISION = 'b8a5c0f183b78c55955a5364f610c36668b5e681';

const TTS_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const TTS_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';

const VOICE_BYTES = 522_240;

/**
 * Whether a path segment is one the model-weights route will serve. Republished
 * from the shared artifact contract rather than restated, because a rule spelled
 * twice lets a tightened route refuse names this script keeps publishing, and
 * every fetch of one answers 404 with nothing reporting the mismatch.
 */
export { isFetchableSegment } from '@hushbox/shared/model-weights';

function predictionArtifact(repoPath: string, file: string, bytes: number): Artifact {
  return {
    model: PREDICTION_MODEL_ID,
    file,
    repo: PREDICTION_REPO,
    revision: PREDICTION_REVISION,
    repoPath,
    bytes,
  };
}

function ttsArtifact(repoPath: string, file: string, bytes: number): Artifact {
  return {
    model: TTS_MODEL_ID,
    file,
    repo: TTS_REPO,
    revision: TTS_REVISION,
    repoPath,
    bytes,
  };
}

/**
 * Every object the two on-device models need, with each Hub-nested source path
 * flattened to its base name.
 *
 * `generation_config.json` is fetched for a decoder-only model even though the
 * loader tolerates its absence; publishing it costs a few hundred bytes and
 * spares every session a 404.
 *
 * The voice blobs derive from the voice list the accessibility preferences
 * offer, so a voice added to the app is published rather than failing alone at
 * runtime while the others work.
 */
export function modelWeightsArtifacts(): readonly Artifact[] {
  const artifacts: readonly Artifact[] = [
    predictionArtifact('onnx/model_int8.onnx', PREDICTION_MODEL_FILES.weights, 135_658_354),
    predictionArtifact('config.json', PREDICTION_MODEL_FILES.config, 976),
    predictionArtifact('generation_config.json', PREDICTION_MODEL_FILES.generationConfig, 132),
    predictionArtifact('tokenizer.json', PREDICTION_MODEL_FILES.tokenizer, 3_522_656),
    predictionArtifact('tokenizer_config.json', PREDICTION_MODEL_FILES.tokenizerConfig, 3794),
    ttsArtifact('onnx/model_quantized.onnx', TTS_MODEL_FILES.weights, 92_361_116),
    ttsArtifact('config.json', TTS_MODEL_FILES.config, 44),
    ttsArtifact('tokenizer.json', TTS_MODEL_FILES.tokenizer, 3497),
    ttsArtifact('tokenizer_config.json', TTS_MODEL_FILES.tokenizerConfig, 113),
    ...TTS_VOICE_IDS.map((voice) =>
      ttsArtifact(`voices/${voice}.bin`, ttsVoiceFileName(voice), VOICE_BYTES)
    ),
  ];

  assertFetchableArtifacts(artifacts);
  return artifacts;
}

/**
 * The speech model's artifacts alone — weights, config, tokenizer, and every
 * voice blob — with the prediction model excluded. No E2E build ever reaches
 * the prediction model (a deterministic stub stands in for it there), so this
 * is the subset the E2E environment seeds, not the full manifest.
 */
export function ttsArtifacts(): readonly Artifact[] {
  return modelWeightsArtifacts().filter((artifact) => artifact.model === TTS_MODEL_ID);
}

/**
 * The prediction model's artifacts alone — weights, config, generation config
 * and tokenizer — with the speech model excluded. The subset a check of the
 * sentence-completion runtime needs, and the one an environment that loads no
 * voice should spend no bytes past.
 */
export function predictionArtifacts(): readonly Artifact[] {
  return modelWeightsArtifacts().filter((artifact) => artifact.model === PREDICTION_MODEL_ID);
}

/**
 * Refuses a set that would publish to an address nothing can ever fetch. The
 * mistake it catches is silent in every other way: a Hub-nested path or an
 * org-prefixed model id uploads cleanly and then answers 404 for the life of
 * the version.
 */
export function assertFetchableArtifacts(artifacts: readonly Artifact[]): void {
  for (const artifact of artifacts) {
    for (const segment of [artifact.model, ARTIFACT_SET_VERSION, artifact.file]) {
      if (!isFetchableSegment(segment)) {
        throw new Error(
          `model weights: "${segment}" is not a segment the model-weights route serves, ` +
            `so ${artifact.repo}/${artifact.repoPath} would publish to an address nothing can fetch`
        );
      }
    }
  }
}

/** The `{bucket}/{key}` path wrangler's `r2 object` commands address. */
export function artifactObjectPath(artifact: Artifact): string {
  const key = modelWeightsObjectKey(artifact.model, ARTIFACT_SET_VERSION, artifact.file);
  return `${MODEL_WEIGHTS_BUCKET}/${key}`;
}

/** Where the source bytes are downloaded from, at the pinned commit. */
export function artifactSourceUrl(artifact: Artifact): string {
  return `https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${artifact.repoPath}`;
}

/**
 * Where downloaded artifacts rest between runs. Under `scripts/.cache/`, which
 * git ignores. Named here beside the layout it roots so that whoever serves
 * these bytes rather than seeding them addresses the same directory: two
 * spellings would leave one reading an empty directory while a seed filled
 * another, and the features these objects serve report nothing when an object
 * is missing.
 */
export const MODEL_WEIGHTS_CACHE_ROOT = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '.cache',
  'model-weights'
);

/** Where a downloaded artifact rests between runs, laid out like the object keys. */
export function artifactCachePath(cacheRoot: string, artifact: Artifact): string {
  return path.join(cacheRoot, artifact.model, ARTIFACT_SET_VERSION, artifact.file);
}

/** The combined download size, derived so no prose has to restate it. */
export function artifactTotalBytes(artifacts: readonly Artifact[]): number {
  return artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
}

/**
 * Identifies an artifact set by what a store would have to hold to satisfy it.
 * A local seed records this, so a version bump, a new voice or a corrected size
 * re-seeds while an unchanged set costs one file read.
 */
export function artifactSetFingerprint(artifacts: readonly Artifact[]): string {
  const shape = artifacts.map((artifact) => [
    artifact.model,
    ARTIFACT_SET_VERSION,
    artifact.file,
    artifact.bytes,
  ]);
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}
