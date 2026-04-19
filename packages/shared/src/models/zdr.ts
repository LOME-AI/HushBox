import type { Modality } from './types.js';

// ---------------------------------------------------------------------------
// ZDR model allow-lists — explicit per-modality
//
// A provider can ship both ZDR and non-ZDR models, so membership is per-model,
// not per-provider. Adding a new model (ZDR-compliant) requires adding its ID
// here. This is the single source of truth for model-level ZDR compliance.
//
// Exported as `as const` tuples so consumers can derive typed id unions and
// enforce membership at compile time (e.g. pinned "strongest" / "value" model
// constants in `constants.ts` use `satisfies ZdrTextModelId` to fail the build
// if the ID ever leaves this list).
// ---------------------------------------------------------------------------

export const ZDR_TEXT_MODEL_IDS = [
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
] as const;

export type ZdrTextModelId = (typeof ZDR_TEXT_MODEL_IDS)[number];

export const ZDR_IMAGE_MODEL_IDS = [
  'google/gemini-2.5-flash-image',
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image',
  'google/imagen-4.0-generate-001',
  'google/imagen-4.0-fast-generate-001',
  'google/imagen-4.0-ultra-generate-001',
] as const;

export type ZdrImageModelId = (typeof ZDR_IMAGE_MODEL_IDS)[number];

export const ZDR_VIDEO_MODEL_IDS = [
  'google/veo-3.1-generate-001',
  'google/veo-3.1-fast-generate-001',
  'google/veo-3.0-fast-generate-001',
  'google/veo-3.0-generate-001',
] as const;

export type ZdrVideoModelId = (typeof ZDR_VIDEO_MODEL_IDS)[number];

export const ZDR_AUDIO_MODEL_IDS = [] as const;

// Runtime Set views — typed so callers can still use `.has()` ergonomically.
export const ZDR_TEXT_MODELS: ReadonlySet<string> = new Set(ZDR_TEXT_MODEL_IDS);
export const ZDR_IMAGE_MODELS: ReadonlySet<string> = new Set(ZDR_IMAGE_MODEL_IDS);
export const ZDR_VIDEO_MODELS: ReadonlySet<string> = new Set(ZDR_VIDEO_MODEL_IDS);
export const ZDR_AUDIO_MODELS: ReadonlySet<string> = new Set(ZDR_AUDIO_MODEL_IDS);

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
      return ZDR_AUDIO_MODELS.has(modelId);
    }
  }
}
