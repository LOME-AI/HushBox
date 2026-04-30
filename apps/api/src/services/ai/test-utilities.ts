import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { MIN_VIDEO_DURATION_SECONDS } from '@hushbox/shared';
import { createMockAIClient } from './mock.js';
import { createRealAIClient, type EvidenceConfig } from './real.js';
import type { AIClient, InferenceEvent, InferenceStream, ModelInfo, Modality } from './types.js';

const MAX_TEST_TOKEN_PRICE = 0.000_01;
const MAX_TEST_IMAGE_PRICE = 0.05;
const MAX_TEST_VIDEO_PRICE_PER_SECOND = 0.2;

export interface IntegrationClientSetup {
  client: AIClient;
  db: Database | null;
  isMock: boolean;
}

/**
 * Branches on env.isLocalDev — local dev returns the mock client (no key
 * required); CI returns the real client wired with evidence config so
 * `verify:evidence --require=ai-gateway` has something to assert against.
 *
 * Throws fast in CI if AI_GATEWAY_API_KEY or DATABASE_URL is missing.
 */
export function setupIntegrationClient(): IntegrationClientSetup {
  const env = createEnvUtilities({
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
  });

  if (env.isLocalDev) {
    return { client: createMockAIClient(), db: null, isMock: true };
  }

  const apiKey = process.env['AI_GATEWAY_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('AI_GATEWAY_API_KEY is required in CI for AI integration tests.');
  }
  const publicModelsUrl = process.env['PUBLIC_MODELS_URL'];
  if (publicModelsUrl === undefined || publicModelsUrl.length === 0) {
    throw new Error('PUBLIC_MODELS_URL is required in CI for AI integration tests.');
  }
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error(
      'DATABASE_URL is required in CI for AI integration tests (evidence recording).'
    );
  }

  const db = createDb({ connectionString: databaseUrl, neonDev: LOCAL_NEON_DEV_CONFIG });
  const evidence: EvidenceConfig = { db, isCI: env.isCI };
  const client = createRealAIClient({ apiKey, publicModelsUrl, evidence });
  return { client, db, isMock: false };
}

// ---------------------------------------------------------------------------
// Cheapest-model resolution per modality
// ---------------------------------------------------------------------------

export interface TextTestParameters {
  kind: 'text';
  maxOutputTokens: number;
}
export interface ImageTestParameters {
  kind: 'image';
  aspectRatio: string;
}
export interface VideoTestParameters {
  kind: 'video';
  duration: number;
  resolution: string;
}
export type TestParameters = TextTestParameters | ImageTestParameters | VideoTestParameters;

export interface TestModelSpec {
  modelId: string;
  parameters: TestParameters;
}

const cachedSpecs = new Map<Modality, TestModelSpec>();

export function clearTestModelCache(): void {
  cachedSpecs.clear();
}

/**
 * Returns the cheapest paid ZDR model for the modality plus the lowest
 * supported parameters (1:1 aspect for image; 1s + cheapest resolution for
 * video). Cached across calls within a test run.
 *
 * Throws for `audio` (no audio models in scope) and for `image`/`video` when
 * no model satisfies the price ceiling — silent fallbacks would mask pricing
 * data regressions.
 */
export async function getCheapestTestModel(
  client: AIClient,
  modality: Modality
): Promise<TestModelSpec> {
  const cached = cachedSpecs.get(modality);
  if (cached !== undefined) return cached;

  const allModels = await client.listModels();
  const candidates = allModels.filter((m) => m.modality === modality && m.isZdr);

  let spec: TestModelSpec;
  switch (modality) {
    case 'text': {
      spec = pickCheapestTextModel(candidates);
      break;
    }
    case 'image': {
      spec = pickCheapestImageModel(candidates);
      break;
    }
    case 'video': {
      spec = pickCheapestVideoModel(candidates);
      break;
    }
    case 'audio': {
      throw new Error('Audio integration tests are not in scope.');
    }
  }

  cachedSpecs.set(modality, spec);
  return spec;
}

function pickCheapestTextModel(candidates: readonly ModelInfo[]): TestModelSpec {
  const paidZdr = candidates.filter(
    (m) => m.pricing.kind === 'token' && m.pricing.inputPerToken > 0 && m.pricing.outputPerToken > 0
  );
  const sortedAll = paidZdr.toSorted((a, b) => textTotalPrice(a) - textTotalPrice(b));
  const withinThreshold = sortedAll.find(
    (m) =>
      m.pricing.kind === 'token' &&
      m.pricing.inputPerToken <= MAX_TEST_TOKEN_PRICE &&
      m.pricing.outputPerToken <= MAX_TEST_TOKEN_PRICE
  );
  const cheapest = withinThreshold ?? sortedAll[0];
  if (cheapest === undefined) {
    throw new Error('No paid ZDR text model available.');
  }
  return { modelId: cheapest.id, parameters: { kind: 'text', maxOutputTokens: 10 } };
}

function textTotalPrice(model: ModelInfo): number {
  if (model.pricing.kind !== 'token') return Number.POSITIVE_INFINITY;
  return model.pricing.inputPerToken + model.pricing.outputPerToken;
}

function pickCheapestImageModel(candidates: readonly ModelInfo[]): TestModelSpec {
  const priced = candidates.filter(
    (m) =>
      m.pricing.kind === 'image' &&
      m.pricing.perImage > 0 &&
      m.pricing.perImage <= MAX_TEST_IMAGE_PRICE
  );
  const sorted = priced.toSorted((a, b) => imagePrice(a) - imagePrice(b));
  const cheapest = sorted[0];
  if (cheapest === undefined) {
    throw new Error('No paid ZDR image model found within MAX_TEST_IMAGE_PRICE.');
  }
  return { modelId: cheapest.id, parameters: { kind: 'image', aspectRatio: '1:1' } };
}

function imagePrice(model: ModelInfo): number {
  if (model.pricing.kind !== 'image') return Number.POSITIVE_INFINITY;
  return model.pricing.perImage;
}

interface VideoCandidate {
  modelId: string;
  resolution: string;
  pricePerSecond: number;
}

function videoCandidatesFrom(model: ModelInfo): VideoCandidate[] {
  if (model.pricing.kind !== 'video') return [];
  return Object.entries(model.pricing.perSecondByResolution)
    .filter(
      ([, pricePerSecond]) =>
        pricePerSecond > 0 && pricePerSecond <= MAX_TEST_VIDEO_PRICE_PER_SECOND
    )
    .map(([resolution, pricePerSecond]) => ({ modelId: model.id, resolution, pricePerSecond }));
}

function pickCheapestVideoModel(candidates: readonly ModelInfo[]): TestModelSpec {
  const allEntries = candidates.flatMap((m) => videoCandidatesFrom(m));
  const sorted = allEntries.toSorted((a, b) => a.pricePerSecond - b.pricePerSecond);
  const cheapest = sorted[0];
  if (cheapest === undefined) {
    throw new Error('No paid ZDR video model found within MAX_TEST_VIDEO_PRICE_PER_SECOND.');
  }
  return {
    modelId: cheapest.modelId,
    parameters: {
      kind: 'video',
      duration: MIN_VIDEO_DURATION_SECONDS,
      resolution: cheapest.resolution,
    },
  };
}

// ---------------------------------------------------------------------------
// Stream consumption + media verification
// ---------------------------------------------------------------------------

export interface ConsumedStream {
  events: InferenceEvent[];
  generationId: string | undefined;
  textContent: string;
  mediaBytes: Uint8Array | undefined;
  mediaMimeType: string | undefined;
  mediaWidth: number | undefined;
  mediaHeight: number | undefined;
  mediaDurationMs: number | undefined;
  timestamps: number[];
}

export async function consumeStream(stream: InferenceStream): Promise<ConsumedStream> {
  const events: InferenceEvent[] = [];
  const timestamps: number[] = [];
  let textContent = '';
  let mediaBytes: Uint8Array | undefined;
  let mediaMimeType: string | undefined;
  let mediaWidth: number | undefined;
  let mediaHeight: number | undefined;
  let mediaDurationMs: number | undefined;
  let generationId: string | undefined;

  for await (const event of stream) {
    events.push(event);
    timestamps.push(Date.now());
    switch (event.kind) {
      case 'text-delta': {
        textContent += event.content;
        break;
      }
      case 'media-done': {
        mediaBytes = event.bytes;
        mediaMimeType = event.mimeType;
        mediaWidth = event.width;
        mediaHeight = event.height;
        mediaDurationMs = event.durationMs;
        break;
      }
      case 'finish': {
        generationId = event.providerMetadata?.generationId;
        break;
      }
      // media-start carries no payload we capture
    }
  }

  return {
    events,
    generationId,
    textContent,
    mediaBytes,
    mediaMimeType,
    mediaWidth,
    mediaHeight,
    mediaDurationMs,
    timestamps,
  };
}

export interface MediaSizeBounds {
  min: number;
  max: number;
}

/**
 * Asserts that `bytes` is a parseable file in one of `allowedMimeTypes` and
 * within `sizeBoundsBytes`. Detection uses hand-rolled magic byte checks for
 * the formats AI providers actually emit (PNG, JPEG, WebP, MP4) — no new
 * dependency required.
 */
export function assertValidMediaBytes(
  bytes: Uint8Array,
  allowedMimeTypes: readonly string[],
  sizeBoundsBytes: MediaSizeBounds
): { detectedMime: string } {
  if (bytes.byteLength < sizeBoundsBytes.min) {
    throw new Error(
      `Media bytes too small: ${String(bytes.byteLength)} < ${String(sizeBoundsBytes.min)}`
    );
  }
  if (bytes.byteLength > sizeBoundsBytes.max) {
    throw new Error(
      `Media bytes too large: ${String(bytes.byteLength)} > ${String(sizeBoundsBytes.max)}`
    );
  }
  const detectedMime = detectMimeFromBytes(bytes);
  if (detectedMime === undefined) {
    throw new Error('Unable to detect media format from byte signature.');
  }
  if (!allowedMimeTypes.includes(detectedMime)) {
    throw new Error(
      `Detected MIME ${detectedMime} not in allowed list [${allowedMimeTypes.join(', ')}]`
    );
  }
  return { detectedMime };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (const [index, expected] of prefix.entries()) {
    if (bytes[offset + index] !== expected) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70] as const;

function detectMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) {
    return 'image/webp';
  }
  if (startsWith(bytes, FTYP_SIGNATURE, 4)) return 'video/mp4';
  return undefined;
}
