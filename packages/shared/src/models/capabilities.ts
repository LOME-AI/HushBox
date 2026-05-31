/**
 * Provider-side capability data for AI Gateway models — the axes each model
 * accepts that the public `/v1/models` catalog doesn't expose (or exposes
 * inconsistently). Single source of truth for both production code (request
 * shaping in `apps/api/services/ai/real.ts`, route-level validation) and
 * integration tests (capability-driven model picker).
 *
 * Adding a new ZDR-allowlisted media model requires two edits:
 *   1. Add its id to the matching `ZDR_*_MODEL_IDS` in `./zdr.ts`.
 *   2. Add its capability entry below.
 * The `satisfies Record<ZdrVideoModelId, VideoCapability>` clause on
 * `VEO_CAPABILITY` fails the build when step 1 happens without step 2.
 */

import type { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, IMAGE_ASPECT_RATIOS } from '../constants.js';
import type { ZdrVideoModelId } from './zdr.js';

// ---------------------------------------------------------------------------
// Strong types — derived from the existing `as const` arrays in constants.ts
// so '4K' / '21:9' / '1080P' fail at compile time anywhere downstream.
// ---------------------------------------------------------------------------

export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

// ---------------------------------------------------------------------------
// Video capability
// ---------------------------------------------------------------------------

export interface VideoCapability {
  readonly aspectRatios: readonly VideoAspectRatio[];
  readonly resolutions: readonly VideoResolution[];
  readonly durationsSeconds: readonly number[];
}

/**
 * Per-Veo-version capability. Veo 3.0 supports `[5, 6, 7, 8]s` at 720p/1080p;
 * Veo 3.1 supports `[4, 6, 8]s` at 720p/1080p/4K. Veo 3.1 reference-image
 * variants are 8s-only but that mode isn't surfaced today.
 */
export const VEO_CAPABILITY = {
  'google/veo-3.0-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    durationsSeconds: [5, 6, 7, 8],
  },
  'google/veo-3.0-fast-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    durationsSeconds: [5, 6, 7, 8],
  },
  'google/veo-3.1-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    durationsSeconds: [4, 6, 8],
  },
  'google/veo-3.1-fast-generate-001': {
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4k'],
    durationsSeconds: [4, 6, 8],
  },
} as const satisfies Record<ZdrVideoModelId, VideoCapability>;

// ---------------------------------------------------------------------------
// Image capability — per-model Imagen sample size
// ---------------------------------------------------------------------------

export type ImagenSampleSize = '1K' | '2K';

/**
 * Imagen 4 sample size — fast variant is 1K only; generate and ultra support
 * 2K. Not user-visible (flat pricing → no tradeoff), injected at request-build
 * time. Models absent from this map use the gateway default and receive no
 * `google.sampleImageSize` provider option.
 */
export const IMAGEN_SAMPLE_SIZE_BY_MODEL = {
  'google/imagen-4.0-fast-generate-001': '1K',
  'google/imagen-4.0-generate-001': '2K',
  'google/imagen-4.0-ultra-generate-001': '2K',
} as const satisfies Record<string, ImagenSampleSize>;

// ---------------------------------------------------------------------------
// ZDR provider options — sent on every inference call. Belt-and-suspenders
// with the catalog filter and `assertZdrModel()` at the stream() boundary.
// ---------------------------------------------------------------------------

/**
 * Provider options forwarded on every inference call.
 *
 * `gateway.zeroDataRetention` is the belt-and-suspenders ZDR guarantee paired
 * with the catalog filter and `assertZdrModel()` at the stream boundary.
 *
 * `openai.serviceTier: 'flex'` and `google.serviceTier: 'flex'` opt into the
 * Vercel AI Gateway's flex pricing pool (50% off standard). On models that
 * don't expose a flex tier (Anthropic, xAI, Veo, etc.) the field is a
 * documented no-op — the gateway routes at standard, bills at standard, and
 * surfaces the served tier in `providerMetadata.gateway.serviceTier`.
 * `vertex.sharedRequestType` is the Vertex-routed-Gemini variant of the
 * same flag.
 *
 * Once `@ai-sdk/gateway` is bumped to ≥ 3.0.120 these three keys collapse to
 * a single `gateway.serviceTier: 'flex'` (the unified field added in that
 * release). Until then the per-provider form is the only way the installed
 * 3.0.95 schema accepts.
 */
export const ZDR_PROVIDER_OPTIONS = {
  gateway: { zeroDataRetention: true },
  openai: { serviceTier: 'flex' },
  google: { serviceTier: 'flex' },
  vertex: { sharedRequestType: 'flex' },
} as const;

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getVideoCapability(modelId: string): VideoCapability | undefined {
  return (VEO_CAPABILITY as Record<string, VideoCapability>)[modelId];
}

export function getSupportedVideoDurations(modelId: string): readonly number[] | undefined {
  return getVideoCapability(modelId)?.durationsSeconds;
}

export function getSupportedVideoResolutions(
  modelId: string
): readonly VideoResolution[] | undefined {
  return getVideoCapability(modelId)?.resolutions;
}

export function getSupportedVideoAspectRatios(
  modelId: string
): readonly VideoAspectRatio[] | undefined {
  return getVideoCapability(modelId)?.aspectRatios;
}

export function getImagenSampleSize(modelId: string): ImagenSampleSize | undefined {
  return (IMAGEN_SAMPLE_SIZE_BY_MODEL as Record<string, ImagenSampleSize>)[modelId];
}
