import { describe, expect, it } from 'vitest';
import {
  isFetchableSegment,
  modelWeightsObjectKey,
  modelWeightsRoutePath,
  ttsVoiceFileName,
} from './model-weights.ts';

describe('modelWeightsObjectKey', () => {
  it('addresses one object per model, version and file', () => {
    expect(modelWeightsObjectKey('kokoro-82m', '1', 'config.json')).toBe(
      'models/kokoro-82m/1/config.json'
    );
  });
});

describe('ttsVoiceFileName', () => {
  it('names a voice blob as one flat segment', () => {
    expect(ttsVoiceFileName('af_heart')).toBe('af_heart.bin');
  });
});

describe('isFetchableSegment', () => {
  it('accepts a flat alphanumeric-led name', () => {
    expect(isFetchableSegment('model_int8.onnx')).toBe(true);
  });

  it('refuses a name carrying a separator', () => {
    expect(isFetchableSegment('onnx/model_int8.onnx')).toBe(false);
  });

  it('refuses a leading dot', () => {
    expect(isFetchableSegment('.hidden')).toBe(false);
  });

  it('refuses a parent-directory hop inside a name', () => {
    expect(isFetchableSegment('model..onnx')).toBe(false);
  });

  it('accepts a name at the length cap', () => {
    expect(isFetchableSegment('a'.repeat(128))).toBe(true);
  });

  it('refuses a name one character past the cap', () => {
    expect(isFetchableSegment('a'.repeat(129))).toBe(false);
  });
});

describe('modelWeightsRoutePath', () => {
  it('addresses one served artifact per model, version and file', () => {
    expect(modelWeightsRoutePath('kokoro-82m', '1', 'config.json')).toBe(
      '/models/kokoro-82m/1/config.json'
    );
  });
});
