import { describe, it, expect } from 'vitest';
import {
  isZdrModel,
  ZDR_TEXT_MODELS,
  ZDR_IMAGE_MODELS,
  ZDR_VIDEO_MODELS,
  ZDR_AUDIO_MODELS,
} from './zdr.js';

describe('ZDR model sets', () => {
  it('ZDR_TEXT_MODELS contains known ZDR-compliant text models', () => {
    expect(ZDR_TEXT_MODELS.has('anthropic/claude-opus-4.6')).toBe(true);
    expect(ZDR_TEXT_MODELS.has('openai/gpt-5')).toBe(true);
    expect(ZDR_TEXT_MODELS.has('google/gemini-2.5-flash')).toBe(true);
  });

  it('ZDR_IMAGE_MODELS contains known ZDR-compliant image models', () => {
    expect(ZDR_IMAGE_MODELS.has('google/imagen-4.0-generate-001')).toBe(true);
    expect(ZDR_IMAGE_MODELS.has('google/gemini-3-pro-image')).toBe(true);
  });

  it('ZDR_VIDEO_MODELS contains known ZDR-compliant video models', () => {
    expect(ZDR_VIDEO_MODELS.has('google/veo-3.1-generate-001')).toBe(true);
  });

  it('ZDR_AUDIO_MODELS is empty until audio is enabled', () => {
    expect(ZDR_AUDIO_MODELS.size).toBe(0);
  });

  it('text and image sets do not overlap', () => {
    for (const id of ZDR_TEXT_MODELS) {
      expect(ZDR_IMAGE_MODELS.has(id)).toBe(false);
    }
  });

  it('text and video sets do not overlap', () => {
    for (const id of ZDR_TEXT_MODELS) {
      expect(ZDR_VIDEO_MODELS.has(id)).toBe(false);
    }
  });
});

describe('isZdrModel', () => {
  it('returns true for a known text model with text modality', () => {
    expect(isZdrModel('anthropic/claude-opus-4.6', 'text')).toBe(true);
  });

  it('returns false for a known text model queried with image modality', () => {
    expect(isZdrModel('anthropic/claude-opus-4.6', 'image')).toBe(false);
  });

  it('returns true for a known image model with image modality', () => {
    expect(isZdrModel('google/imagen-4.0-generate-001', 'image')).toBe(true);
  });

  it('returns true for a known video model with video modality', () => {
    expect(isZdrModel('google/veo-3.1-generate-001', 'video')).toBe(true);
  });

  it('returns false for an unknown model', () => {
    expect(isZdrModel('fake/not-a-real-model', 'text')).toBe(false);
  });

  it('returns false for any audio model (audio modality empty)', () => {
    expect(isZdrModel('some/audio-model', 'audio')).toBe(false);
  });
});
