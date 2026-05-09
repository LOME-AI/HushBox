import {
  CHARS_PER_TOKEN_STANDARD,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  assertNever,
} from '@hushbox/shared';

import { rawModelToModelInfo } from './model-mapping.js';
import {
  TEST_IMAGE_BYTES,
  TEST_AUDIO_BYTES,
  TEST_VIDEO_BYTES,
  TEST_IMAGE_MIME,
  TEST_AUDIO_MIME,
  TEST_VIDEO_MIME,
  TEST_IMAGE_WIDTH,
  TEST_IMAGE_HEIGHT,
  TEST_AUDIO_DURATION_MS,
  TEST_VIDEO_DURATION_MS,
  TEST_VIDEO_WIDTH,
  TEST_VIDEO_HEIGHT,
} from './mock-fixtures/index.js';
import type { RawModel } from '@hushbox/shared/models';
import type {
  AIMessage,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  MockAIClient,
  ModelInfo,
  RecordedInferenceRequest,
  TextRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deterministic mock cost returned by getGenerationStats (USD). */
const MOCK_GENERATION_STATS_COST = 0.001;

/**
 * Default model id returned by classifier calls — overridable per test.
 *
 * Must be a cheap text model so it lands in the integration harness's top-N
 * eligible set (`buildHarness` sorts by cost). claude-haiku-4.5 is one of the
 * cheapest entries in the catalog below.
 */
const DEFAULT_CLASSIFIER_RESOLUTION = 'anthropic/claude-haiku-4.5';

// ---------------------------------------------------------------------------
// Canned media buffers
//
// Bytes are loaded from `./mock-fixtures/` — real CC0 sample media so that
// dev/E2E surfaces show actual playable content instead of header-only
// placeholders. See `mock-fixtures/README.md` for source URLs and license.
// Re-exported so tests round-tripping raw bytes (encrypt → decrypt → compare)
// can pull the canonical values.
// ---------------------------------------------------------------------------

export {
  TEST_IMAGE_BYTES as CANNED_IMAGE,
  TEST_VIDEO_BYTES as CANNED_VIDEO,
  TEST_AUDIO_BYTES as CANNED_AUDIO,
  TEST_IMAGE_WIDTH as CANNED_IMAGE_WIDTH,
  TEST_IMAGE_HEIGHT as CANNED_IMAGE_HEIGHT,
  TEST_VIDEO_DURATION_MS as CANNED_VIDEO_DURATION_MS,
  TEST_VIDEO_WIDTH as CANNED_VIDEO_WIDTH,
  TEST_VIDEO_HEIGHT as CANNED_VIDEO_HEIGHT,
  TEST_AUDIO_DURATION_MS as CANNED_AUDIO_DURATION_MS,
} from './mock-fixtures/index.js';

// ---------------------------------------------------------------------------
// Mock model catalogue
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the mock model catalog.
 *
 * Shaped as `RawModel[]` (the gateway-side merged shape) so `processModels`
 * — used by `/api/models`, the chat tier-gate, and billing premium-id checks
 * — sees the same data the real gateway produces. `MOCK_MODELS` (ModelInfo)
 * is derived from this via `rawModelToModelInfo`, keeping inference-layer
 * pricing and the routes' premium classification consistent in tests.
 *
 * Pricing strings follow the gateway's per-token / per-image / per-second
 * conventions. The text entries are real ZDR ids (anthropic/claude-*) so
 * `processModels` keeps them after ZDR filtering. The image/video/audio
 * entries are intentionally not on the ZDR allow-list; `processModels`
 * filters them out, which is correct (production uses real ZDR ids), while
 * `listModels()` still returns them for inference-layer mock streaming.
 */
const MOCK_RAW_MODELS: RawModel[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    description: 'Fast, intelligent model for everyday tasks',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'anthropic/claude-opus-4.6',
    name: 'Claude Opus 4.6',
    description: 'Most capable model for complex tasks',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: '0.000015', completion: '0.000075' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    description: 'Fast, cheap model for everyday tasks',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: '0.0000003', completion: '0.0000015' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'openai/gpt-5-nano',
    name: 'GPT-5 Nano',
    description: 'Cheap general-purpose model',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: '0.0000004', completion: '0.0000016' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    description: 'Lightweight, low-cost model',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: '0.00000025', completion: '0.0000012' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    description: 'Balanced cost-quality model',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: '0.0000005', completion: '0.0000018' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'google/imagen-4.0-generate-001',
    name: 'Imagen 4',
    description: 'High-quality image generation',
    modality: 'image',
    context_length: 0,
    pricing: { prompt: '0', completion: '0', per_image: '0.04' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['image'], output_modalities: ['image'] },
  },
  {
    id: 'google/imagen-4.0-fast-generate-001',
    name: 'Imagen 4 Fast',
    description: 'Fast image generation',
    modality: 'image',
    context_length: 0,
    pricing: { prompt: '0', completion: '0', per_image: '0.04' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['image'], output_modalities: ['image'] },
  },
  {
    id: 'google/veo-3.1-generate-001',
    name: 'Veo 3.1',
    description: 'Video generation with audio',
    modality: 'video',
    context_length: 0,
    pricing: {
      prompt: '0',
      completion: '0',
      per_second_by_resolution: { '720p': '0.1', '1080p': '0.15' },
    },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['video'], output_modalities: ['video'] },
  },
  {
    id: 'google/veo-3.1-fast-generate-001',
    name: 'Veo 3.1 Fast',
    description: 'Fast video generation with audio',
    modality: 'video',
    context_length: 0,
    pricing: {
      prompt: '0',
      completion: '0',
      per_second_by_resolution: { '720p': '0.12', '1080p': '0.18' },
    },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['video'], output_modalities: ['video'] },
  },
  {
    id: 'openai/tts-1',
    name: 'TTS-1',
    description: 'Text-to-speech audio generation',
    modality: 'audio',
    context_length: 0,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['audio'], output_modalities: ['audio'] },
  },
];

const MOCK_AUDIO_PER_SECOND = 0.015;

const MOCK_MODELS: ModelInfo[] = MOCK_RAW_MODELS.map((m) => {
  const info = rawModelToModelInfo(m);
  // The shared mapper hardcodes audio.perSecond to 0 because the gateway
  // fetcher doesn't extract audio pricing yet. Override here so the mock
  // exposes a deterministic non-zero rate; chat-pipeline tests rely on
  // perSecond × duration math producing a fixed cost.
  if (info.modality === 'audio' && info.pricing.kind === 'audio') {
    return { ...info, pricing: { kind: 'audio', perSecond: MOCK_AUDIO_PER_SECOND } };
  }
  return info;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLastUserContent(messages: AIMessage[]): string {
  const lastUser = messages.findLast((m) => m.role === 'user');
  if (!lastUser) return 'No message';
  return typeof lastUser.content === 'string'
    ? lastUser.content
    : lastUser.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
}

// ---------------------------------------------------------------------------
// Stream generators
// ---------------------------------------------------------------------------

/** Wrap a sync generator into an InferenceStream (AsyncIterator). */
function syncStream(generate: () => Generator<InferenceEvent>): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const iterator = generate();
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

function messageContentLength(content: string | MessageContentPart[]): number {
  if (typeof content === 'string') return content.length;
  let length = 0;
  for (const part of content) {
    if (part.type === 'text') length += part.text.length;
  }
  return length;
}

function countPromptCharacters(messages: AIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += messageContentLength(message.content);
  }
  return total;
}

function isClassifierRequest(request: TextRequest): boolean {
  const system = request.messages.find((m) => m.role === 'system');
  if (!system) return false;
  const content = typeof system.content === 'string' ? system.content : '';
  return content.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER);
}

function createClassifierStream(modelId: string): InferenceStream {
  return syncStream(function* (): Generator<InferenceEvent> {
    for (const char of modelId) {
      yield { kind: 'text-delta', content: char };
    }
    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-classifier-${String(Date.now())}`,
        usage: {
          inputTokens: Math.ceil(modelId.length / CHARS_PER_TOKEN_STANDARD),
          outputTokens: Math.ceil(modelId.length / CHARS_PER_TOKEN_STANDARD),
        },
      },
    };
  });
}

function createFailingClassifierStream(error: Error): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          return Promise.reject(error);
        },
      };
    },
  };
}

function createTextStream(request: TextRequest): InferenceStream {
  const echoContent = `Echo: ${extractLastUserContent(request.messages)}`;

  return syncStream(function* (): Generator<InferenceEvent> {
    for (const char of echoContent) {
      yield { kind: 'text-delta', content: char };
    }

    const promptCharacters = countPromptCharacters(request.messages);

    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
        usage: {
          inputTokens: Math.ceil(promptCharacters / CHARS_PER_TOKEN_STANDARD),
          outputTokens: Math.ceil(echoContent.length / CHARS_PER_TOKEN_STANDARD),
        },
      },
    };
  });
}

function createImageStream(): InferenceStream {
  return syncStream(function* (): Generator<InferenceEvent> {
    yield { kind: 'media-start', mediaType: 'image', mimeType: TEST_IMAGE_MIME };
    yield {
      kind: 'media-done',
      bytes: TEST_IMAGE_BYTES,
      mimeType: TEST_IMAGE_MIME,
      width: TEST_IMAGE_WIDTH,
      height: TEST_IMAGE_HEIGHT,
    };
    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
      },
    };
  });
}

function createVideoStream(): InferenceStream {
  return syncStream(function* (): Generator<InferenceEvent> {
    yield { kind: 'media-start', mediaType: 'video', mimeType: TEST_VIDEO_MIME };
    yield {
      kind: 'media-done',
      bytes: TEST_VIDEO_BYTES,
      mimeType: TEST_VIDEO_MIME,
      width: TEST_VIDEO_WIDTH,
      height: TEST_VIDEO_HEIGHT,
      durationMs: TEST_VIDEO_DURATION_MS,
    };
    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
      },
    };
  });
}

function createAudioStream(): InferenceStream {
  return syncStream(function* (): Generator<InferenceEvent> {
    yield { kind: 'media-start', mediaType: 'audio', mimeType: TEST_AUDIO_MIME };
    yield {
      kind: 'media-done',
      bytes: TEST_AUDIO_BYTES,
      mimeType: TEST_AUDIO_MIME,
      durationMs: TEST_AUDIO_DURATION_MS,
    };
    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMockAIClient(): MockAIClient {
  const history: RecordedInferenceRequest[] = [];
  const failingModels = new Set<string>();
  let classifierResolution = DEFAULT_CLASSIFIER_RESOLUTION;
  let classifierFailure: Error | null = null;

  return {
    isMock: true,

    listModels(): Promise<ModelInfo[]> {
      return Promise.resolve([...MOCK_MODELS]);
    },

    listRawModels(): Promise<RawModel[]> {
      // structuredClone so callers can't mutate the shared catalog array.
      return Promise.resolve(MOCK_RAW_MODELS.map((m) => structuredClone(m)));
    },

    getModel(id: string): Promise<ModelInfo> {
      const model = MOCK_MODELS.find((m) => m.id === id);
      if (!model) return Promise.reject(new Error(`Model not found: ${id}`));
      return Promise.resolve({ ...model });
    },

    stream(request: InferenceRequest): InferenceStream {
      if (failingModels.has(request.model)) {
        const errorMessage = `Model ${request.model} is unavailable`;
        return {
          [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
            return {
              next(): Promise<IteratorResult<InferenceEvent>> {
                return Promise.reject(new Error(errorMessage));
              },
            };
          },
        };
      }

      // The mock never reaches a real gateway, so ZDR is moot in practice;
      // we tag every recorded request with `zdrEnforced: true` so test
      // assertions can detect a future regression on the real-client path
      // (where ZDR_PROVIDER_OPTIONS must be set on EVERY SDK call). Mock
      // stays a faithful stand-in: if real.ts loses ZDR, integration tests
      // fail; if mock loses the flag, this assertion fails.
      const recorded: RecordedInferenceRequest = {
        ...structuredClone(request),
        zdrEnforced: true,
      };
      history.push(recorded);

      switch (request.modality) {
        case 'text': {
          if (isClassifierRequest(request)) {
            if (classifierFailure !== null) {
              return createFailingClassifierStream(classifierFailure);
            }
            return createClassifierStream(classifierResolution);
          }
          return createTextStream(request);
        }
        case 'image': {
          return createImageStream();
        }
        case 'video': {
          return createVideoStream();
        }
        case 'audio': {
          return createAudioStream();
        }
        default: {
          return assertNever(request);
        }
      }
    },

    getGenerationStats(): Promise<{ costUsd: number }> {
      return Promise.resolve({ costUsd: MOCK_GENERATION_STATS_COST });
    },

    getRequestHistory(): RecordedInferenceRequest[] {
      return [...history];
    },

    clearHistory(): void {
      history.length = 0;
    },

    addFailingModel(id: string): void {
      failingModels.add(id);
    },

    clearFailingModels(): void {
      failingModels.clear();
    },

    setClassifierResolution(modelId: string): void {
      classifierResolution = modelId;
    },

    setClassifierFailure(error: Error | null): void {
      classifierFailure = error;
    },
  };
}
