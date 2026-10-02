import { describe, expect, it } from 'vitest';
import { TTS_VOICE_IDS } from '@hushbox/shared';
import {
  MODEL_WEIGHTS_VERSION,
  PREDICTION_MODEL_FILES,
  PREDICTION_MODEL_ID,
  TTS_MODEL_FILES,
  TTS_MODEL_ID,
  modelWeightsObjectKey,
  ttsVoiceFileName,
} from '@hushbox/shared/model-weights';
import { artifactObjectKey, artifactParamsSchema } from './artifact.js';

/**
 * The publisher, this route and the on-device loaders all address the same
 * objects, and a mismatch is invisible: an unfetchable key uploads cleanly and
 * then answers 404 for the life of the version, while the feature it serves is
 * built to fail without a sound. So the shared contract is checked against the
 * validator that decides what this route will serve, rather than the two being
 * trusted to have been written to agree.
 */
const CONTRACT_FILES: readonly { readonly model: string; readonly file: string }[] = [
  ...Object.values(PREDICTION_MODEL_FILES).map((file) => ({ model: PREDICTION_MODEL_ID, file })),
  ...Object.values(TTS_MODEL_FILES).map((file) => ({ model: TTS_MODEL_ID, file })),
  ...TTS_VOICE_IDS.map((voice) => ({ model: TTS_MODEL_ID, file: ttsVoiceFileName(voice) })),
];

describe('the shared artifact contract against this route’s validator', () => {
  it('names an address this route accepts for every published object', () => {
    const refused = CONTRACT_FILES.filter(
      ({ model, file }) =>
        !artifactParamsSchema.safeParse({ model, version: MODEL_WEIGHTS_VERSION, file }).success
    );

    expect(refused).toEqual([]);
  });

  it('builds the published key out of the params the validator accepted', () => {
    const params = artifactParamsSchema.parse({
      model: PREDICTION_MODEL_ID,
      version: MODEL_WEIGHTS_VERSION,
      file: PREDICTION_MODEL_FILES.weights,
    });

    expect(artifactObjectKey(params.model, params.version, params.file)).toBe(
      modelWeightsObjectKey(
        PREDICTION_MODEL_ID,
        MODEL_WEIGHTS_VERSION,
        PREDICTION_MODEL_FILES.weights
      )
    );
  });
});
