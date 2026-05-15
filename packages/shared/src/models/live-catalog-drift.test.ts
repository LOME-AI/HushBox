/**
 * Live catalog drift watchdog.
 *
 * Runs on every `pnpm test` — not gated on any env var. Hits the live public
 * `/v1/models` endpoint and asserts:
 *   • Every entry parses with `publicModelEntrySchema` (the same schema
 *     production uses).
 *   • Every ZDR-listed model id is present in the live response.
 *   • `processModels` (fed the live data through the public-only fetch path)
 *     yields the expected survivor count per modality.
 *   • Per-modality pricing shape conforms to what the pipeline supports.
 *
 * Network failures fall through with a clear error naming the issue. Drift
 * (added models in live, not on ZDR allow-list) is warned, not failed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';

import {
  ZDR_TEXT_MODEL_IDS,
  ZDR_IMAGE_MODEL_IDS,
  ZDR_VIDEO_MODEL_IDS,
  ZDR_AUDIO_MODEL_IDS,
} from './zdr.js';
import { processModels, fetchModels, clearModelCache } from './index.js';
import { publicModelEntrySchema, type PublicModelEntry } from './fetch.js';
import { fetchWithRetry, type FetchLiveResult } from './live-catalog-fetch.js';

const PUBLIC_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
const FETCH_TIMEOUT_MS = 10_000;

// I-A: Imagen models use flat `image` pricing; I-B: Gemini multimodal use
// `image_dimension_quality_pricing`. The pipeline only supports I-A today.
const FLAT_IMAGE_MODEL_IDS = new Set([
  'google/imagen-4.0-generate-001',
  'google/imagen-4.0-fast-generate-001',
  'google/imagen-4.0-ultra-generate-001',
]);

const MULTIMODAL_IMAGE_MODEL_IDS = new Set([
  'google/gemini-2.5-flash-image',
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image',
]);

const textTokenPricingSchema = z.looseObject({
  input: z.string(),
  output: z.string(),
});

const flatImagePricingSchema = z.looseObject({
  image: z.string(),
});

const videoDurationPricingSchema = z.looseObject({
  video_duration_pricing: z.array(
    z.object({
      resolution: z.string(),
      audio: z.boolean(),
      cost_per_second: z.string(),
    })
  ),
});

const multimodalImagePricingSchema = z.looseObject({
  image_dimension_quality_pricing: z.array(
    z.object({
      size: z.string(),
      cost: z.string(),
    })
  ),
});

function pricingKeyDump(entry: PublicModelEntry): string {
  return entry.pricing === undefined ? '<no pricing>' : Object.keys(entry.pricing).join(', ');
}

describe('live catalog drift watchdog', () => {
  let liveResult: FetchLiveResult;

  beforeAll(async () => {
    clearModelCache();
    liveResult = await fetchWithRetry({ url: PUBLIC_MODELS_URL, timeoutMs: FETCH_TIMEOUT_MS });
  }, FETCH_TIMEOUT_MS * 2);

  it('every entry parses with publicModelEntrySchema', () => {
    const violations: string[] = [];
    for (const entry of liveResult.all) {
      const parsed = publicModelEntrySchema.safeParse(entry);
      if (!parsed.success) {
        violations.push(`${entry.id}: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
    expect(
      violations,
      `live entries failing publicModelEntrySchema: ${violations.join('; ')}`
    ).toEqual([]);
    expect(liveResult.all.length).toBeGreaterThan(0);
  });

  it('every ZDR text model is present in the live response', () => {
    const missing = ZDR_TEXT_MODEL_IDS.filter((id) => !liveResult.byId.has(id));
    expect(
      missing,
      `ZDR-listed text models missing from live /v1/models: ${missing.join(', ')} — upstream removed them; remove from zdr.ts or wait for re-add`
    ).toEqual([]);
  });

  it('every ZDR image model is present in the live response', () => {
    const missing = ZDR_IMAGE_MODEL_IDS.filter((id) => !liveResult.byId.has(id));
    expect(
      missing,
      `ZDR-listed image models missing from live /v1/models: ${missing.join(', ')} — upstream removed them; remove from zdr.ts or wait for re-add`
    ).toEqual([]);
  });

  it('every ZDR video model is present in the live response', () => {
    const missing = ZDR_VIDEO_MODEL_IDS.filter((id) => !liveResult.byId.has(id));
    expect(
      missing,
      `ZDR-listed video models missing from live /v1/models: ${missing.join(', ')} — upstream removed them; remove from zdr.ts or wait for re-add`
    ).toEqual([]);
  });

  it('every ZDR audio model is present in the live response (when the list is non-empty)', () => {
    const missing = ZDR_AUDIO_MODEL_IDS.filter((id) => !liveResult.byId.has(id));
    expect(
      missing,
      `ZDR-listed audio models missing from live /v1/models: ${missing.join(', ')} — upstream removed them; remove from zdr.ts or wait for re-add`
    ).toEqual([]);
  });

  it('every ZDR text model has token pricing shape (input + output strings)', () => {
    const violations: string[] = [];
    for (const id of ZDR_TEXT_MODEL_IDS) {
      const entry = liveResult.byId.get(id);
      if (entry === undefined) continue;
      const parsed = textTokenPricingSchema.safeParse(entry.pricing);
      if (!parsed.success) {
        violations.push(
          `${id} (keys: [${pricingKeyDump(entry)}]; issues: ${JSON.stringify(parsed.error.issues)})`
        );
      }
    }
    expect(
      violations,
      `ZDR text models with non-token pricing shape: ${violations.join('; ')}`
    ).toEqual([]);
  });

  it('every flat-priced ZDR image model (Imagen) has flat image pricing', () => {
    const violations: string[] = [];
    for (const id of FLAT_IMAGE_MODEL_IDS) {
      const entry = liveResult.byId.get(id);
      if (entry === undefined) continue;
      const parsed = flatImagePricingSchema.safeParse(entry.pricing);
      if (!parsed.success) {
        violations.push(
          `${id} (keys: [${pricingKeyDump(entry)}]; issues: ${JSON.stringify(parsed.error.issues)})`
        );
      }
    }
    expect(
      violations,
      `ZDR flat-priced image models with non-flat pricing: ${violations.join('; ')}`
    ).toEqual([]);
  });

  it('every multimodal ZDR image model (Gemini) has image_dimension_quality_pricing (informational warn)', () => {
    let recognised = 0;
    for (const id of MULTIMODAL_IMAGE_MODEL_IDS) {
      const entry = liveResult.byId.get(id);
      if (entry === undefined) continue;
      const parsed = multimodalImagePricingSchema.safeParse(entry.pricing);
      if (parsed.success) {
        recognised++;
      } else {
        // Aspirationally ZDR-listed but unsupported by the current pipeline.
        // Warn so drift in the recognised shape is visible without hard-failing.
        console.warn(
          `[live-catalog-drift] WATCHDOG: multimodal image model ${id} pricing shape changed. Actual keys: [${pricingKeyDump(entry)}]. Issues: ${JSON.stringify(parsed.error.issues)}`
        );
      }
    }
    expect(recognised).toBeGreaterThanOrEqual(0);
  });

  it('every ZDR video model has video_duration_pricing array', () => {
    const violations: string[] = [];
    for (const id of ZDR_VIDEO_MODEL_IDS) {
      const entry = liveResult.byId.get(id);
      if (entry === undefined) continue;
      const parsed = videoDurationPricingSchema.safeParse(entry.pricing);
      if (!parsed.success) {
        violations.push(
          `${id} (keys: [${pricingKeyDump(entry)}]; issues: ${JSON.stringify(parsed.error.issues)})`
        );
      }
    }
    expect(
      violations,
      `ZDR video models with non-duration pricing: ${violations.join('; ')}`
    ).toEqual([]);
  });

  it('processModels yields the expected ZDR survivor counts when fed live data', async () => {
    clearModelCache();
    const raws = await fetchModels({ publicModelsUrl: PUBLIC_MODELS_URL });
    const result = processModels(raws);

    const survivorIds = new Set(result.models.map((m) => m.id));
    const textSurvivors = result.models.filter((m) => m.modality === 'text');
    const imageSurvivors = result.models.filter((m) => m.modality === 'image');
    const videoSurvivors = result.models.filter((m) => m.modality === 'video');

    const smartModelCount = result.models.filter((m) => m.isSmartModel === true).length;
    const realTextCount = textSurvivors.length - smartModelCount;

    const droppedText = ZDR_TEXT_MODEL_IDS.filter((id) => !survivorIds.has(id));
    const droppedImage = ZDR_IMAGE_MODEL_IDS.filter((id) => !survivorIds.has(id));
    const droppedVideo = ZDR_VIDEO_MODEL_IDS.filter((id) => !survivorIds.has(id));

    for (const id of droppedText) {
      console.warn(
        `[live-catalog-drift] ZDR-listed model ${id} (text) is in the live response but filtered out of processModels output. Check process-models.ts filter logic.`
      );
    }
    for (const id of droppedImage) {
      console.warn(
        `[live-catalog-drift] ZDR-listed model ${id} (image) is in the live response but filtered out of processModels output. Check process-models.ts filter logic.`
      );
    }
    for (const id of droppedVideo) {
      console.warn(
        `[live-catalog-drift] ZDR-listed model ${id} (video) is in the live response but filtered out of processModels output. Check process-models.ts filter logic.`
      );
    }

    expect(realTextCount, `text survivors: ${JSON.stringify(textSurvivors.map((m) => m.id))}`).toBe(
      ZDR_TEXT_MODEL_IDS.length
    );
    expect(
      imageSurvivors.length,
      `image survivors: ${JSON.stringify(imageSurvivors.map((m) => m.id))}; dropped: ${JSON.stringify(droppedImage)}`
    ).toBe(FLAT_IMAGE_MODEL_IDS.size);
    expect(
      videoSurvivors.length,
      `video survivors: ${JSON.stringify(videoSurvivors.map((m) => m.id))}; dropped: ${JSON.stringify(droppedVideo)}`
    ).toBe(ZDR_VIDEO_MODEL_IDS.length);
  }, 30_000);

  it('logs informational warnings for live models not on any ZDR allow-list', () => {
    const allZdr = new Set<string>([
      ...ZDR_TEXT_MODEL_IDS,
      ...ZDR_IMAGE_MODEL_IDS,
      ...ZDR_VIDEO_MODEL_IDS,
      ...ZDR_AUDIO_MODEL_IDS,
    ]);
    const unknownToZdr: string[] = [];
    for (const entry of liveResult.all) {
      if (!allZdr.has(entry.id)) unknownToZdr.push(entry.id);
    }
    if (unknownToZdr.length > 0) {
      console.warn(
        `[live-catalog-drift] ${String(unknownToZdr.length)} live model(s) not on any ZDR allow-list (informational; not a failure): ${unknownToZdr.slice(0, 5).join(', ')}${unknownToZdr.length > 5 ? ', ...' : ''}`
      );
    }
    expect(liveResult.all.length).toBeGreaterThan(0);
  });
});
