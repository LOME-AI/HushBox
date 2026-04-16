import { streamText, generateImage, experimental_generateVideo } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { isZdrModel } from '@hushbox/shared/models';
import { recordServiceEvidence, SERVICE_NAMES, type Database } from '@hushbox/db';
import type {
  AIClient,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  ModelInfo,
  Modality,
  ModelPricing,
  ProviderMetadata,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
} from './types.js';

/**
 * Optional evidence-recording config.
 * When supplied, the real client calls `recordServiceEvidence` after each
 * successful AI Gateway call so CI can verify the integration was exercised.
 */
export interface EvidenceConfig {
  db: Database;
  isCI: boolean;
}

// ---------------------------------------------------------------------------
// Gateway model type → Modality mapping
// ---------------------------------------------------------------------------

function classifyModality(type: string): Modality {
  switch (type) {
    case 'image': {
      return 'image';
    }
    case 'video': {
      return 'video';
    }
    case 'audio':
    case 'tts': {
      return 'audio';
    }
    default: {
      return 'text';
    }
  }
}

// ---------------------------------------------------------------------------
// Map raw gateway model response to ModelInfo
// ---------------------------------------------------------------------------

interface RawGatewayModel {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  provider?: string;
  contextLength?: number;
  pricing?: Record<string, string>;
  capabilities?: string[];
}

function extractProvider(modelId: string, rawProvider?: string): string {
  if (rawProvider) return rawProvider;
  const slash = modelId.indexOf('/');
  return slash > 0 ? modelId.slice(0, slash) : 'unknown';
}

function defaultPricing(modality: Modality): ModelPricing {
  switch (modality) {
    case 'text': {
      return { kind: 'token', inputPerToken: 0, outputPerToken: 0 };
    }
    case 'image': {
      return { kind: 'image', perImage: 0 };
    }
    case 'video': {
      return { kind: 'video', perSecond: 0 };
    }
    case 'audio': {
      return { kind: 'audio', perSecond: 0 };
    }
  }
}

function parsePrice(raw: string | undefined): number {
  return Number.parseFloat(raw ?? '0') || 0;
}

function parsePricing(modality: Modality, rawPricing?: Record<string, string>): ModelPricing {
  if (!rawPricing) return defaultPricing(modality);

  switch (modality) {
    case 'text': {
      const webSearch = rawPricing['webSearchPerCall'];
      const webSearchPerCall = webSearch ? parsePrice(webSearch) : undefined;
      return {
        kind: 'token',
        inputPerToken: parsePrice(rawPricing['inputPerToken']),
        outputPerToken: parsePrice(rawPricing['outputPerToken']),
        ...(webSearchPerCall === undefined ? {} : { webSearchPerCall }),
      };
    }
    case 'image': {
      return { kind: 'image', perImage: parsePrice(rawPricing['perImage']) };
    }
    case 'video': {
      return { kind: 'video', perSecond: parsePrice(rawPricing['perSecond']) };
    }
    case 'audio': {
      return { kind: 'audio', perSecond: parsePrice(rawPricing['perSecond']) };
    }
  }
}

function toModelInfo(raw: RawGatewayModel): ModelInfo {
  const modality = classifyModality(raw.type ?? 'chat');
  const provider = extractProvider(raw.id, raw.provider);

  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    provider,
    modality,
    description: raw.description ?? '',
    ...(raw.contextLength === undefined ? {} : { contextLength: raw.contextLength }),
    pricing: parsePricing(modality, raw.pricing),
    capabilities: [],
    isZdr: isZdrModel(raw.id, modality),
  };
}

// ---------------------------------------------------------------------------
// ZDR options applied to every AI SDK call
// ---------------------------------------------------------------------------

const ZDR_PROVIDER_OPTIONS = {
  gateway: { zeroDataRetention: true },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractGatewayMeta(
  metadata: Record<string, Record<string, unknown>> | undefined
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  return metadata['gateway'];
}

function buildFinishMetadata(
  gatewayMeta: Record<string, unknown> | undefined,
  usage?: { inputTokens?: number | null; outputTokens?: number | null }
): ProviderMetadata {
  const generationId = gatewayMeta?.['generationId'];
  const result: ProviderMetadata = {};
  if (typeof generationId === 'string') result.generationId = generationId;
  if (usage) {
    result.usage = {
      ...(usage.inputTokens == null ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens == null ? {} : { outputTokens: usage.outputTokens }),
    };
  }
  return result;
}

function convertContentPart(
  part: MessageContentPart
): { type: 'text'; text: string } | { type: 'image'; image: Uint8Array; mimeType: string } {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  return { type: 'image', image: part.data, mimeType: part.mimeType };
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

  const result = streamText({
    model: gateway(request.model),
    ...(systemMessage === undefined
      ? {}
      : { system: typeof systemMessage.content === 'string' ? systemMessage.content : '' }),
    messages: mappedMessages,
    ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
    providerOptions: ZDR_PROVIDER_OPTIONS,
  });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          const raw = part as Record<string, unknown>;
          const text =
            (raw['textDelta'] as string | undefined) ?? (raw['text'] as string | undefined) ?? '';
          if (text.length > 0) {
            yield { kind: 'text-delta', content: text };
          }
        }
      }

      const metadata = await result.providerMetadata;
      const gatewayMeta = extractGatewayMeta(
        metadata as Record<string, Record<string, unknown>> | undefined
      );
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

      const image = result.image;
      const bytes = image.uint8Array;
      const mimeType = (image as unknown as { mimeType?: string }).mimeType ?? 'image/png';

      yield { kind: 'media-start', mediaType: 'image', mimeType };
      yield { kind: 'media-done', bytes, mimeType };

      const imageGatewayMeta = extractGatewayMeta(
        result.providerMetadata as unknown as Record<string, Record<string, unknown>> | undefined
      );
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
        model: gateway.videoModel(request.model),
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

      const video = result.video;
      const bytes = video.uint8Array;
      const mimeType = (video as unknown as { mimeType?: string }).mimeType ?? 'video/mp4';

      yield { kind: 'media-start', mediaType: 'video', mimeType };
      yield { kind: 'media-done', bytes, mimeType };

      const videoGatewayMeta = extractGatewayMeta(
        result.providerMetadata as unknown as Record<string, Record<string, unknown>> | undefined
      );
      yield { kind: 'finish', providerMetadata: buildFinishMetadata(videoGatewayMeta) };
    },
  };
}

// ---------------------------------------------------------------------------
// Audio generation (behind feature flag — placeholder until gateway support)
// ---------------------------------------------------------------------------

function streamAudioRequest(_request: AudioRequest): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      let done = false;
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          if (done) return Promise.resolve({ done: true, value: undefined });
          done = true;
          return Promise.resolve({
            done: false,
            value: { kind: 'finish' as const },
          });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRealAIClient(apiKey: string, evidence?: EvidenceConfig): AIClient {
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

    async listModels(): Promise<ModelInfo[]> {
      const response = await gateway.getAvailableModels();
      const rawModels = (response as { models: RawGatewayModel[] }).models;
      const models = rawModels.map((m) => toModelInfo(m));
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
      }
    },

    async getGenerationStats(generationId: string): Promise<{ costUsd: number }> {
      const info = await gateway.getGenerationInfo({ id: generationId });
      const result = { costUsd: (info as { totalCost: number }).totalCost };
      await recordEvidence();
      return result;
    },
  };
}
