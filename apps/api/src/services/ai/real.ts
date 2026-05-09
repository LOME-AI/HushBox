import {
  streamText,
  generateImage,
  experimental_generateVideo,
  gateway as gatewayTools,
  stepCountIs,
} from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import { fetchModels } from '@hushbox/shared/models';
import { MAX_SEARCH_TOOL_CALLS, assertNever } from '@hushbox/shared';
import {
  recordServiceEvidence,
  SERVICE_NAMES,
  type EvidenceConfig as SharedEvidenceConfig,
} from '@hushbox/db';
import { rawModelToModelInfo } from './model-mapping.js';
import type { RawModel } from '@hushbox/shared/models';
import type { ImagePart, TextPart } from 'ai';
import type {
  AIClient,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  ModelInfo,
  ProviderMetadata,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
} from './types.js';

/**
 * Optional evidence-recording config. When supplied, the real client calls
 * `recordServiceEvidence` after each successful AI Gateway call so CI can
 * verify the integration was exercised. New callers should import
 * `EvidenceConfig` directly from `@hushbox/db`; this re-export remains for
 * existing call sites.
 */
export type EvidenceConfig = SharedEvidenceConfig;

// ---------------------------------------------------------------------------
// ZDR options applied to every AI SDK call
// ---------------------------------------------------------------------------

const ZDR_PROVIDER_OPTIONS = {
  gateway: { zeroDataRetention: true },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Provider-metadata Zod schema for the `gateway` namespace. The AI Gateway
 * docs declare `providerMetadata.gateway.generationId: string` (used for
 * `getGenerationInfo({ id })`).
 *
 * The `gateway` namespace itself is optional — some flows return metadata
 * without it. But once the namespace IS present, we require `generationId`
 * to be a string. If the SDK ever renames that field, parsing fails loudly
 * here rather than silently producing `undefined` and breaking cost lookups.
 */
const gatewayProviderMetaSchema = z.looseObject({
  gateway: z
    .looseObject({
      generationId: z.string(),
    })
    .optional(),
});

function extractGatewayMeta(metadata: unknown): { generationId?: string } | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = gatewayProviderMetaSchema.safeParse(metadata);
  if (!parsed.success) {
    // Drift guard: the gateway namespace exists but does not match the
    // documented shape. Fail loudly so upgrades cannot silently lose the
    // generationId breadcrumb that drives cost reconciliation.
    const candidate =
      typeof metadata === 'object' ? (metadata as { gateway?: unknown }).gateway : undefined;
    if (candidate !== undefined) {
      throw new Error('Gateway generation metadata schema drift — generationId missing');
    }
    return undefined;
  }
  const inner = parsed.data.gateway;
  if (inner === undefined) return undefined;
  return { generationId: inner.generationId };
}

function buildFinishMetadata(
  gatewayMeta: { generationId?: string } | undefined,
  usage?: { inputTokens?: number | null; outputTokens?: number | null }
): ProviderMetadata {
  const result: ProviderMetadata = {};
  if (gatewayMeta?.generationId !== undefined) result.generationId = gatewayMeta.generationId;
  if (usage) {
    result.usage = {
      ...(usage.inputTokens == null ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens == null ? {} : { outputTokens: usage.outputTokens }),
    };
  }
  return result;
}

/**
 * Convert our internal `MessageContentPart` to the AI SDK v6 wire shape.
 *
 * The return type is constrained by the `TextPart` / `ImagePart` imports from
 * the `ai` package (re-exported from `@ai-sdk/provider-utils`) so a future
 * SDK rename of `mediaType` (or any other ImagePart field) fails compilation
 * here rather than silently breaking image inputs at runtime. AI SDK v6
 * declares the field as `mediaType?: string` — NOT `mimeType` — so we map
 * our internal `mimeType` onto the SDK's `mediaType`.
 */
function convertContentPart(
  part: MessageContentPart
): TextPart | (Pick<ImagePart, 'type' | 'mediaType'> & { image: Uint8Array }) {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  return { type: 'image', image: part.data, mediaType: part.mimeType };
}

// ---------------------------------------------------------------------------
// Text streaming
// ---------------------------------------------------------------------------

function streamTextRequest(
  gateway: ReturnType<typeof createGateway>,
  request: TextRequest
): InferenceStream {
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

  const mappedMessages = nonSystemMessages.map((m) => {
    if (m.role === 'assistant') {
      // Assistant messages only support text content in the AI SDK
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map((p) => p.text)
              .join('');
      return { role: 'assistant' as const, content: text };
    }
    const content =
      typeof m.content === 'string' ? m.content : m.content.map((p) => convertContentPart(p));
    return { role: 'user' as const, content };
  });

  const searchTools =
    request.webSearchEnabled === true
      ? { perplexitySearch: gatewayTools.tools.perplexitySearch() }
      : undefined;

  const result = streamText({
    model: gateway(request.model),
    ...(systemMessage === undefined
      ? {}
      : { system: typeof systemMessage.content === 'string' ? systemMessage.content : '' }),
    messages: mappedMessages,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    providerOptions: ZDR_PROVIDER_OPTIONS,
    ...(searchTools === undefined
      ? {}
      : { tools: searchTools, stopWhen: stepCountIs(MAX_SEARCH_TOOL_CALLS) }),
  });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      for await (const part of result.fullStream) {
        if (
          part.type === 'text-delta' && // v6 TextStreamTextDeltaPart: { type: 'text-delta'; text: string; ... }
          part.text.length > 0
        ) {
          yield { kind: 'text-delta', content: part.text };
        }
      }

      const metadata = await result.providerMetadata;
      const gatewayMeta = extractGatewayMeta(metadata);
      const usage = await result.totalUsage;

      yield {
        kind: 'finish',
        providerMetadata: buildFinishMetadata(gatewayMeta, {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

function streamImageRequest(
  gateway: ReturnType<typeof createGateway>,
  request: ImageRequest
): InferenceStream {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const result = await generateImage({
        model: gateway.imageModel(request.model),
        prompt: request.prompt,
        ...(request.aspectRatio === undefined
          ? {}
          : { aspectRatio: request.aspectRatio as `${number}:${number}` }),
        ...(request.size === undefined ? {} : { size: request.size as `${number}x${number}` }),
        ...(request.n === undefined ? {} : { n: request.n }),
        providerOptions: ZDR_PROVIDER_OPTIONS,
      });

      const file = result.images[0];
      if (file === undefined) throw new Error('Empty image generation result');
      const bytes = file.uint8Array;
      const mimeType = file.mediaType;

      yield { kind: 'media-start', mediaType: 'image', mimeType };
      yield { kind: 'media-done', bytes, mimeType };

      const imageGatewayMeta = extractGatewayMeta(result.providerMetadata);
      yield { kind: 'finish', providerMetadata: buildFinishMetadata(imageGatewayMeta) };
    },
  };
}

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

function streamVideoRequest(
  gateway: ReturnType<typeof createGateway>,
  request: VideoRequest
): InferenceStream {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const result = await experimental_generateVideo({
        model: gateway.video(request.model),
        prompt: request.prompt,
        ...(request.aspectRatio === undefined
          ? {}
          : { aspectRatio: request.aspectRatio as `${number}:${number}` }),
        ...(request.resolution === undefined
          ? {}
          : { resolution: request.resolution as `${number}x${number}` }),
        ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
        providerOptions: ZDR_PROVIDER_OPTIONS,
      });

      const file = result.videos[0];
      if (file === undefined) throw new Error('Empty video generation result');
      const bytes = file.uint8Array;
      const mimeType = file.mediaType;

      yield { kind: 'media-start', mediaType: 'video', mimeType };
      yield { kind: 'media-done', bytes, mimeType };

      const videoGatewayMeta = extractGatewayMeta(result.providerMetadata);
      yield { kind: 'finish', providerMetadata: buildFinishMetadata(videoGatewayMeta) };
    },
  };
}

// ---------------------------------------------------------------------------
// Audio generation
// ---------------------------------------------------------------------------

/**
 * Audio output is not yet supported by the Vercel AI Gateway. This function
 * is dead-coded behind `FEATURE_FLAGS.AUDIO_ENABLED`. When the gateway adds
 * speech-model support, replace the throw with the same pattern as
 * `streamImageRequest` / `streamVideoRequest`. The strategy and types are
 * already shaped correctly; flipping the flag should be sufficient.
 *
 * Until then, fail loud rather than emit a silent finish that downstream
 * pipelines would mistake for a successful generation. The route's flag
 * check plus the missing ZDR audio model list together guarantee this is
 * unreachable in production.
 */
function streamAudioRequest(_request: AudioRequest): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          return Promise.reject(new Error('Audio output is not yet supported by the AI Gateway'));
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateRealAIClientOptions {
  apiKey: string;
  /** URL of the unauthenticated `/v1/models` endpoint for media pricing. */
  publicModelsUrl: string;
  evidence?: EvidenceConfig;
}

export function createRealAIClient(options: CreateRealAIClientOptions): AIClient {
  const { apiKey, publicModelsUrl, evidence } = options;
  const gateway = createGateway({ apiKey });

  const recordEvidence = async (): Promise<void> => {
    if (!evidence) return;
    await recordServiceEvidence(evidence.db, evidence.isCI, SERVICE_NAMES.AI_GATEWAY);
  };

  /** Wrap an upstream InferenceStream so evidence is recorded after the first successful event. */
  const withEvidenceOnStream = (upstream: InferenceStream): InferenceStream => {
    if (!evidence) return upstream;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
        let recorded = false;
        for await (const event of upstream) {
          if (!recorded) {
            recorded = true;
            await recordEvidence();
          }
          yield event;
        }
      },
    };
  };

  return {
    isMock: false,

    listRawModels(): Promise<RawModel[]> {
      // Single boundary for raw gateway data — every caller (chat tier-gate,
      // billing premium-id check, /api/models route) flows through here so
      // the env fork in `getAIClient` is the only place we read the API key.
      return fetchModels({ apiKey, publicModelsUrl });
    },

    async listModels(): Promise<ModelInfo[]> {
      const rawModels = await this.listRawModels();
      const models = rawModels.map((m) => rawModelToModelInfo(m));
      await recordEvidence();
      return models;
    },

    async getModel(id: string): Promise<ModelInfo> {
      const models = await this.listModels();
      const model = models.find((m) => m.id === id);
      if (!model) throw new Error(`Model not found: ${id}`);
      return model;
    },

    stream(request: InferenceRequest): InferenceStream {
      switch (request.modality) {
        case 'text': {
          return withEvidenceOnStream(streamTextRequest(gateway, request));
        }
        case 'image': {
          return withEvidenceOnStream(streamImageRequest(gateway, request));
        }
        case 'video': {
          return withEvidenceOnStream(streamVideoRequest(gateway, request));
        }
        case 'audio': {
          return withEvidenceOnStream(streamAudioRequest(request));
        }
        default: {
          return assertNever(request);
        }
      }
    },

    async getGenerationStats(generationId: string): Promise<{ costUsd: number }> {
      const info = await gateway.getGenerationInfo({ id: generationId });
      const result = { costUsd: info.totalCost };
      await recordEvidence();
      return result;
    },
  };
}
