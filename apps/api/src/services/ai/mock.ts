import {
  CHARS_PER_TOKEN_STANDARD,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  assertNever,
  type AllowedMediaMimeType,
} from '@hushbox/shared';

import { rawModelToModelInfo } from './model-mapping.js';
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

/**
 * Mime types emitted by the canned media streams. The `satisfies` clause makes
 * the compiler reject any value not in the {@link AllowedMediaMimeType}
 * allowlist, so the mock and the schema enum can never drift apart.
 */
const MOCK_IMAGE_MIME = 'image/png' as const satisfies AllowedMediaMimeType;
const MOCK_VIDEO_MIME = 'video/mp4' as const satisfies AllowedMediaMimeType;
const MOCK_AUDIO_MIME = 'audio/wav' as const satisfies AllowedMediaMimeType;

// ---------------------------------------------------------------------------
// Canned media buffers
// ---------------------------------------------------------------------------

/** Width (and height) of the canned PNG returned by image generation calls. */
export const CANNED_PNG_WIDTH = 16;
/** Height of the canned PNG returned by image generation calls. */
export const CANNED_PNG_HEIGHT = 16;

/**
 * Valid 16×16 PNG with a single all-black RGB pixel grid (73 bytes).
 * Browsers can decode this — used so E2E tests can assert
 * `naturalWidth/naturalHeight` on the rendered <img>.
 *
 * Structure: PNG signature + IHDR (16×16, 8-bit RGB) + IDAT (deflated all-zero
 * pixel rows) + IEND.
 */
export const CANNED_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x91, 0x68,
  0x36, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x18, 0x05, 0xa3,
  0x60, 0x14, 0xc0, 0x00, 0x00, 0x03, 0x10, 0x00, 0x01, 0x3f, 0x2c, 0x2b, 0xec, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** Duration of the canned MP4 in mvhd timescale units (= 2 seconds at 1000 units/sec). */
export const CANNED_MP4_DURATION = 2000;

/**
 * Valid (header-only) MP4 with a parseable moov atom (485 bytes). Contains a
 * ftyp box advertising isom/mp42/avc1 brands and a moov atom with a single
 * video track, mvhd timescale 1000, duration 2000 (= 2 seconds), and minimal
 * stbl entries. Browsers can read `duration` metadata off this without crashing
 * — needed so E2E tests can assert `<video>.duration`.
 *
 * Note: contains no media samples (stco/stsz/stts entries are zero) so playback
 * will not produce frames; metadata extraction is the only goal.
 */
export const CANNED_MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32, 0x61, 0x76, 0x63, 0x31, 0x00, 0x00, 0x01, 0xc9,
  0x6d, 0x6f, 0x6f, 0x76, 0x00, 0x00, 0x00, 0x6c, 0x6d, 0x76, 0x68, 0x64, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x07, 0xd0,
  0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
  0x00, 0x00, 0x01, 0x55, 0x74, 0x72, 0x61, 0x6b, 0x00, 0x00, 0x00, 0x5c, 0x74, 0x6b, 0x68, 0x64,
  0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00,
  0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf1, 0x6d, 0x64, 0x69, 0x61, 0x00, 0x00, 0x00, 0x20,
  0x6d, 0x64, 0x68, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x07, 0xd0, 0x55, 0xc4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2d,
  0x68, 0x64, 0x6c, 0x72, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x76, 0x69, 0x64, 0x65,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x56, 0x69, 0x64, 0x65,
  0x6f, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72, 0x00, 0x00, 0x00, 0x00, 0x9c, 0x6d, 0x69, 0x6e,
  0x66, 0x00, 0x00, 0x00, 0x14, 0x76, 0x6d, 0x68, 0x64, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x24, 0x64, 0x69, 0x6e, 0x66, 0x00, 0x00, 0x00,
  0x1c, 0x64, 0x72, 0x65, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x0c, 0x75, 0x72, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x5c, 0x73, 0x74, 0x62,
  0x6c, 0x00, 0x00, 0x00, 0x10, 0x73, 0x74, 0x73, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x10, 0x73, 0x74, 0x74, 0x73, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x10, 0x73, 0x74, 0x73, 0x63, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x14, 0x73, 0x74, 0x73, 0x7a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x73, 0x74, 0x63, 0x6f, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * Minimal WAV header (44 bytes, 0 data samples — silent).
 */
const CANNED_WAV = new Uint8Array([
  // "RIFF" header
  0x52,
  0x49,
  0x46,
  0x46, // "RIFF"
  0x24,
  0x00,
  0x00,
  0x00, // chunk size (36 + 0 data bytes)
  0x57,
  0x41,
  0x56,
  0x45, // "WAVE"
  // "fmt " sub-chunk
  0x66,
  0x6d,
  0x74,
  0x20, // "fmt "
  0x10,
  0x00,
  0x00,
  0x00, // sub-chunk size: 16
  0x01,
  0x00, // audio format: PCM
  0x01,
  0x00, // channels: 1 (mono)
  0x44,
  0xac,
  0x00,
  0x00, // sample rate: 44100
  0x88,
  0x58,
  0x01,
  0x00, // byte rate: 88200
  0x02,
  0x00, // block align: 2
  0x10,
  0x00, // bits per sample: 16
  // "data" sub-chunk
  0x64,
  0x61,
  0x74,
  0x61, // "data"
  0x00,
  0x00,
  0x00,
  0x00, // data size: 0 (silent)
]);

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
    yield { kind: 'media-start', mediaType: 'image', mimeType: MOCK_IMAGE_MIME };
    yield {
      kind: 'media-done',
      bytes: CANNED_PNG,
      mimeType: MOCK_IMAGE_MIME,
      width: CANNED_PNG_WIDTH,
      height: CANNED_PNG_HEIGHT,
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
    yield { kind: 'media-start', mediaType: 'video', mimeType: MOCK_VIDEO_MIME };
    yield {
      kind: 'media-done',
      bytes: CANNED_MP4,
      mimeType: MOCK_VIDEO_MIME,
      width: 1920,
      height: 1080,
      durationMs: 2000,
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
    yield { kind: 'media-start', mediaType: 'audio', mimeType: MOCK_AUDIO_MIME };
    yield {
      kind: 'media-done',
      bytes: CANNED_WAV,
      mimeType: MOCK_AUDIO_MIME,
      durationMs: 1000,
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
