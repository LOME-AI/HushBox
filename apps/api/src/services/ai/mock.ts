import type {
  AIMessage,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  MockAIClient,
  ModelInfo,
  TextRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters per token approximation for deterministic cost. */
const CHARS_PER_TOKEN = 4;

/** Deterministic mock cost returned by getGenerationStats (USD). */
const MOCK_GENERATION_STATS_COST = 0.001;

// ---------------------------------------------------------------------------
// Canned media buffers
// ---------------------------------------------------------------------------

/**
 * Minimal valid 1x1 PNG (67 bytes).
 * PNG signature + IHDR + IDAT + IEND.
 */
const CANNED_PNG = new Uint8Array([
  // PNG signature
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  // IHDR chunk (13 bytes data)
  0x00,
  0x00,
  0x00,
  0x0d, // length
  0x49,
  0x48,
  0x44,
  0x52, // "IHDR"
  0x00,
  0x00,
  0x00,
  0x01, // width: 1
  0x00,
  0x00,
  0x00,
  0x01, // height: 1
  0x08,
  0x02, // bit depth 8, color type RGB
  0x00,
  0x00,
  0x00, // compression, filter, interlace
  0x90,
  0x77,
  0x53,
  0xde, // CRC
  // IDAT chunk (minimal deflate of single black pixel row)
  0x00,
  0x00,
  0x00,
  0x0c, // length
  0x49,
  0x44,
  0x41,
  0x54, // "IDAT"
  0x08,
  0xd7,
  0x63,
  0x60,
  0x60,
  0x60,
  0x00,
  0x00,
  0x00,
  0x04,
  0x00,
  0x01, // CRC
  // IEND chunk
  0x00,
  0x00,
  0x00,
  0x00, // length
  0x49,
  0x45,
  0x4e,
  0x44, // "IEND"
  0xae,
  0x42,
  0x60,
  0x82, // CRC
]);

/**
 * Minimal MP4 placeholder (ftyp + moov atoms, not playable but non-empty).
 */
const CANNED_MP4 = new Uint8Array([
  // ftyp box
  0x00,
  0x00,
  0x00,
  0x14, // size: 20
  0x66,
  0x74,
  0x79,
  0x70, // "ftyp"
  0x69,
  0x73,
  0x6f,
  0x6d, // major_brand: "isom"
  0x00,
  0x00,
  0x00,
  0x01, // minor_version
  0x69,
  0x73,
  0x6f,
  0x6d, // compatible_brand
  // moov box (minimal, 8 bytes)
  0x00,
  0x00,
  0x00,
  0x08,
  0x6d,
  0x6f,
  0x6f,
  0x76, // "moov"
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

const MOCK_MODELS: ModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    modality: 'text',
    description: 'Fast, intelligent model for everyday tasks',
    contextLength: 200_000,
    pricing: { kind: 'token', inputPerToken: 0.000_003, outputPerToken: 0.000_015 },
    capabilities: [],
    isZdr: true,
  },
  {
    id: 'anthropic/claude-opus-4.6',
    name: 'Claude Opus 4.6',
    provider: 'Anthropic',
    modality: 'text',
    description: 'Most capable model for complex tasks',
    contextLength: 200_000,
    pricing: { kind: 'token', inputPerToken: 0.000_015, outputPerToken: 0.000_075 },
    capabilities: [],
    isZdr: true,
  },
  {
    id: 'google/imagen-4',
    name: 'Imagen 4',
    provider: 'Google',
    modality: 'image',
    description: 'High-quality image generation',
    pricing: { kind: 'image', perImage: 0.04 },
    capabilities: ['aspect-ratio'],
    isZdr: true,
  },
  {
    id: 'google/veo-3.1',
    name: 'Veo 3.1',
    provider: 'Google',
    modality: 'video',
    description: 'Video generation with audio',
    pricing: { kind: 'video', perSecond: 0.1 },
    capabilities: ['aspect-ratio', 'duration'],
    isZdr: true,
  },
  {
    id: 'openai/tts-1',
    name: 'TTS-1',
    provider: 'OpenAI',
    modality: 'audio',
    description: 'Text-to-speech audio generation',
    pricing: { kind: 'audio', perSecond: 0.015 },
    capabilities: [],
    isZdr: true,
  },
];

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
          inputTokens: Math.ceil(promptCharacters / CHARS_PER_TOKEN),
          outputTokens: Math.ceil(echoContent.length / CHARS_PER_TOKEN),
        },
      },
    };
  });
}

function createImageStream(): InferenceStream {
  return syncStream(function* (): Generator<InferenceEvent> {
    yield { kind: 'media-start', mediaType: 'image', mimeType: 'image/png' };
    yield {
      kind: 'media-done',
      bytes: CANNED_PNG,
      mimeType: 'image/png',
      width: 1,
      height: 1,
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
    yield { kind: 'media-start', mediaType: 'video', mimeType: 'video/mp4' };
    yield {
      kind: 'media-done',
      bytes: CANNED_MP4,
      mimeType: 'video/mp4',
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
    yield { kind: 'media-start', mediaType: 'audio', mimeType: 'audio/wav' };
    yield {
      kind: 'media-done',
      bytes: CANNED_WAV,
      mimeType: 'audio/wav',
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
  const history: InferenceRequest[] = [];
  const failingModels = new Set<string>();

  return {
    isMock: true,

    listModels(): Promise<ModelInfo[]> {
      return Promise.resolve([...MOCK_MODELS]);
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

      history.push(structuredClone(request));

      switch (request.modality) {
        case 'text': {
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
      }
    },

    getGenerationStats(): Promise<{ costUsd: number }> {
      return Promise.resolve({ costUsd: MOCK_GENERATION_STATS_COST });
    },

    getRequestHistory(): InferenceRequest[] {
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
  };
}
