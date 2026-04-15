import type { Modality } from './types.js';

// ---------------------------------------------------------------------------
// ZDR model allow-lists — explicit per-modality
//
// A provider can ship both ZDR and non-ZDR models, so membership is per-model,
// not per-provider. Adding a new model (ZDR-compliant) requires adding its ID
// here. This is the single source of truth for model-level ZDR compliance.
// ---------------------------------------------------------------------------

export const ZDR_TEXT_MODELS = new Set<string>([
  'google/gemini-3-flash',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.4-mini',
  'google/gemini-2.5-flash-lite',
  'anthropic/claude-haiku-4.5',
  'minimax/minimax-m2.5',
  'openai/gpt-5.4',
  'google/gemini-3.1-pro-preview',
  'moonshotai/kimi-k2.5',
  'openai/gpt-5.4-nano',
  'google/gemini-3.1-flash-lite-preview',
  'openai/gpt-oss-120b',
  'google/gemini-2.5-flash',
  'openai/gpt-4.1-mini',
  'openai/gpt-5-mini',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-4o-mini',
  'zai/glm-5',
  'openai/gpt-5.1-instant',
  'openai/gpt-5.1-thinking',
  'openai/gpt-5-nano',
  'openai/gpt-5',
]);

export const ZDR_IMAGE_MODELS = new Set<string>([
  'google/gemini-2.5-flash-image',
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image',
  'google/imagen-4.0-generate-001',
  'google/imagen-4.0-fast-generate-001',
  'google/imagen-4.0-ultra-generate-001',
]);

export const ZDR_VIDEO_MODELS = new Set<string>([
  'google/veo-3.1-generate-001',
  'google/veo-3.1-fast-generate-001',
  'google/veo-3.0-fast-generate-001',
  'google/veo-3.0-generate-001',
]);

export const ZDR_AUDIO_MODELS = new Set<string>();

/** True if the model is on the ZDR allow-list for the given modality. */
export function isZdrModel(modelId: string, modality: Modality): boolean {
  switch (modality) {
    case 'text': {
      return ZDR_TEXT_MODELS.has(modelId);
    }
    case 'image': {
      return ZDR_IMAGE_MODELS.has(modelId);
    }
    case 'video': {
      return ZDR_VIDEO_MODELS.has(modelId);
    }
    case 'audio': {
      // eslint-disable-next-line sonarjs/no-empty-collection -- empty until FEATURE_FLAGS.AUDIO_ENABLED
      return ZDR_AUDIO_MODELS.has(modelId);
    }
  }
}
