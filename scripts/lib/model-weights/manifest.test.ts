import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { TTS_VOICE_IDS } from '@hushbox/shared';
import {
  ARTIFACT_SET_VERSION,
  MODEL_WEIGHTS_BUCKET,
  PREDICTION_MODEL_ID,
  TTS_MODEL_ID,
  artifactCachePath,
  artifactObjectPath,
  artifactSetFingerprint,
  artifactSourceUrl,
  artifactTotalBytes,
  assertFetchableArtifacts,
  isFetchableSegment,
  modelWeightsArtifacts,
  modelWeightsBucketIn,
  predictionArtifacts,
  ttsArtifacts,
} from './manifest.js';
import type { Artifact } from './manifest.js';

const artifacts = modelWeightsArtifacts();

const filesOf = (model: string): string[] =>
  artifacts.filter((a) => a.model === model).map((a) => a.file);

describe('the segment rule the model-weights route enforces', () => {
  it('accepts a flat alphanumeric-led name', () => {
    expect(isFetchableSegment('model_int8.onnx')).toBe(true);
  });

  it('refuses a nested path, which the route reads as three segments', () => {
    expect(isFetchableSegment('onnx/model_int8.onnx')).toBe(false);
  });

  it('refuses a leading dot, which the route reads as a hidden or relative name', () => {
    expect(isFetchableSegment('.hidden')).toBe(false);
  });

  it('refuses a parent-directory hop inside an otherwise legal name', () => {
    expect(isFetchableSegment('model..onnx')).toBe(false);
  });

  it('refuses a name past the length the route caps segments at', () => {
    expect(isFetchableSegment(`a${'b'.repeat(128)}`)).toBe(false);
  });
});

describe('the published artifact set', () => {
  it('names every segment in a shape the route can serve', () => {
    const unfetchable = artifacts
      .flatMap((a) => [a.model, ARTIFACT_SET_VERSION, a.file])
      .filter((segment) => !isFetchableSegment(segment));

    expect(unfetchable).toEqual([]);
  });

  it('flattens a Hub-nested source path to its base name', () => {
    const weights = artifacts.find((a) => a.repoPath === 'onnx/model_int8.onnx');

    expect(weights?.file).toBe('model_int8.onnx');
  });

  it('carries the prediction model’s weights, config and tokenizer', () => {
    expect(new Set(filesOf(PREDICTION_MODEL_ID))).toEqual(
      new Set([
        'config.json',
        'generation_config.json',
        'model_int8.onnx',
        'tokenizer.json',
        'tokenizer_config.json',
      ])
    );
  });

  it('carries the speech model’s weights, config and tokenizer', () => {
    expect(filesOf(TTS_MODEL_ID)).toEqual(
      expect.arrayContaining([
        'model_quantized.onnx',
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
      ])
    );
  });

  it('carries one voice blob for every voice the app offers', () => {
    const voiceFiles = filesOf(TTS_MODEL_ID).filter((file) => file.endsWith('.bin'));

    expect(new Set(voiceFiles)).toEqual(new Set(TTS_VOICE_IDS.map((id) => `${id}.bin`)));
  });

  it('pins every download to a Hub commit rather than a moving branch', () => {
    const unpinned = artifacts.filter((a) => !/^[0-9a-f]{40}$/.test(a.revision));

    expect(unpinned).toEqual([]);
  });

  it('declares a positive expected size for every artifact', () => {
    expect(artifacts.filter((a) => a.bytes <= 0)).toEqual([]);
  });

  it('names each object once', () => {
    const paths = artifacts.map((a) => artifactObjectPath(a));

    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('the speech-only artifact subset', () => {
  it('carries only the speech model’s artifacts, none of the prediction model’s', () => {
    const subset = ttsArtifacts();

    expect(subset.every((a) => a.model === TTS_MODEL_ID)).toBe(true);
    expect(subset.some((a) => a.model === PREDICTION_MODEL_ID)).toBe(false);
  });

  it('matches every speech-model artifact the full set carries', () => {
    expect(ttsArtifacts()).toEqual(modelWeightsArtifacts().filter((a) => a.model === TTS_MODEL_ID));
  });
});

describe('the prediction-only artifact subset', () => {
  it('carries only the prediction model’s artifacts, none of the speech model’s', () => {
    const subset = predictionArtifacts();

    expect(subset.every((a) => a.model === PREDICTION_MODEL_ID)).toBe(true);
    expect(subset.some((a) => a.model === TTS_MODEL_ID)).toBe(false);
  });

  it('matches every prediction-model artifact the full set carries', () => {
    expect(predictionArtifacts()).toEqual(
      modelWeightsArtifacts().filter((a) => a.model === PREDICTION_MODEL_ID)
    );
  });
});

describe('the guard on a set that would publish somewhere unfetchable', () => {
  const nested: Artifact = {
    model: 'kokoro-82m',
    file: 'voices/af_heart.bin',
    repo: 'r',
    revision: 'e',
    repoPath: 'voices/af_heart.bin',
    bytes: 1,
  };

  it('refuses a file name the route cannot address', () => {
    expect(() => {
      assertFetchableArtifacts([nested]);
    }).toThrow('voices/af_heart.bin');
  });

  it('names the source file, so the manifest entry at fault is identifiable', () => {
    expect(() => {
      assertFetchableArtifacts([nested]);
    }).toThrow(/r\/voices\/af_heart\.bin/);
  });

  it('refuses a model id the route cannot address', () => {
    expect(() => {
      assertFetchableArtifacts([{ ...nested, file: 'a.bin', model: 'onnx-community/Kokoro' }]);
    }).toThrow('onnx-community/Kokoro');
  });

  it('accepts the set the manifest actually declares', () => {
    expect(() => {
      assertFetchableArtifacts(artifacts);
    }).not.toThrow();
  });
});

describe('the bucket the published objects rest in', () => {
  /**
   * The Worker's own config is the only authority, because the drift a second
   * spelling permits is silent: a remote mismatch errors at upload, but the
   * local R2 emulator materialises a store under whatever name it is handed, so
   * seeding would fill one bucket while the binding read another and both
   * on-device features would serve 404 with nothing reporting it.
   */
  const bound = (binding: string, bucketName: string): string =>
    ['[[r2_buckets]]', `binding = "${binding}"`, `bucket_name = "${bucketName}"`].join('\n');

  it('reads the bucket its binding names rather than restating one', () => {
    expect(modelWeightsBucketIn(bound('MODEL_WEIGHTS', 'a-bucket'))).toBe('a-bucket');
  });

  it('takes its own binding, not the first bucket the Worker declares', () => {
    const config = [bound('OTHER_BUCKET', 'not-this-one'), bound('MODEL_WEIGHTS', 'this-one')].join(
      '\n\n'
    );
    expect(modelWeightsBucketIn(config)).toBe('this-one');
  });

  it('refuses a config that binds no bucket under that name', () => {
    expect(() => modelWeightsBucketIn(bound('OTHER_BUCKET', 'a-bucket'))).toThrow('MODEL_WEIGHTS');
  });

  it('refuses a config declaring no R2 bucket at all', () => {
    expect(() => modelWeightsBucketIn('[vars]\nNODE_ENV = "production"')).toThrow('MODEL_WEIGHTS');
  });

  it('refuses a binding whose bucket name is not a string', () => {
    const config = ['[[r2_buckets]]', 'binding = "MODEL_WEIGHTS"', 'bucket_name = 7'].join('\n');
    expect(() => modelWeightsBucketIn(config)).toThrow('bucket_name');
  });

  it('publishes to whatever the API Worker binds, so the two cannot drift', () => {
    // The one assertion that reads the real config: it is what would fail if
    // the exported name ever went back to being a copy of the binding's.
    expect(MODEL_WEIGHTS_BUCKET).toBe(
      modelWeightsBucketIn(
        readFileSync(
          path.resolve(import.meta.dirname, '..', '..', '..', 'apps', 'api', 'wrangler.toml'),
          'utf8'
        )
      )
    );
  });
});

describe('the addresses derived from one artifact', () => {
  const artifact: Artifact = {
    model: 'kokoro-82m',
    file: 'af_heart.bin',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    repoPath: 'voices/af_heart.bin',
    bytes: 522_240,
  };

  it('addresses the object under the bucket, the models prefix, the model and the version', () => {
    expect(artifactObjectPath(artifact)).toBe(
      `${MODEL_WEIGHTS_BUCKET}/models/kokoro-82m/${ARTIFACT_SET_VERSION}/af_heart.bin`
    );
  });

  it('downloads from the pinned revision, keeping the nested source path', () => {
    expect(artifactSourceUrl(artifact)).toBe(
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/af_heart.bin'
    );
  });

  it('caches under the same model and version the object key uses', () => {
    expect(artifactCachePath('/cache', artifact)).toBe(
      path.join('/cache', 'kokoro-82m', ARTIFACT_SET_VERSION, 'af_heart.bin')
    );
  });
});

describe('the artifact-set fingerprint', () => {
  const base: Artifact = {
    model: 'kokoro-82m',
    file: 'af_heart.bin',
    repo: 'r',
    revision: 'e',
    repoPath: 'voices/af_heart.bin',
    bytes: 522_240,
  };

  it('is stable for the same set', () => {
    expect(artifactSetFingerprint([base])).toBe(artifactSetFingerprint([base]));
  });

  it('changes when an artifact is added', () => {
    expect(artifactSetFingerprint([base, { ...base, file: 'bf_emma.bin' }])).not.toBe(
      artifactSetFingerprint([base])
    );
  });

  it('changes when an artifact’s expected size changes', () => {
    expect(artifactSetFingerprint([{ ...base, bytes: 1 }])).not.toBe(
      artifactSetFingerprint([base])
    );
  });
});

describe('the download total', () => {
  it('sums every artifact’s expected size', () => {
    expect(
      artifactTotalBytes([
        { model: 'm', file: 'a', repo: 'r', revision: 'e', repoPath: 'a', bytes: 2 },
        { model: 'm', file: 'b', repo: 'r', revision: 'e', repoPath: 'b', bytes: 3 },
      ])
    ).toBe(5);
  });
});
