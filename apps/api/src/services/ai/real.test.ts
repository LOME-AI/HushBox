import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  InferenceEvent,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
} from './types.js';

const mockStreamText = vi.fn();
const mockGenerateImage = vi.fn();
const mockGenerateVideo = vi.fn();
const mockPerplexitySearchTool = vi.fn(() => ({ __mockPerplexityTool: true }));
const mockStepCountIs = vi.fn((n: number) => ({ __mockStopWhen: n }));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  generateImage: mockGenerateImage,
  experimental_generateVideo: mockGenerateVideo,
  stepCountIs: mockStepCountIs,
  gateway: {
    tools: {
      perplexitySearch: mockPerplexitySearchTool,
    },
  },
}));

const mockGatewayInstance = {
  __call: vi.fn(),
  imageModel: vi.fn(),
  video: vi.fn(),
  getAvailableModels: vi.fn(),
  getGenerationInfo: vi.fn(),
};

// The gateway is callable: gateway('model-id') returns a language model
const mockGateway = Object.assign(mockGatewayInstance.__call, mockGatewayInstance);

vi.mock('@ai-sdk/gateway', () => ({
  createGateway: vi.fn(() => mockGateway),
}));

// Mock shared fetchModels so listModels tests don't need the two-endpoint merge.
// real.ts delegates to fetchModels; we mock at that seam.
const mockFetchModels = vi.fn();
vi.mock('@hushbox/shared/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared/models')>();
  return {
    ...actual,
    fetchModels: mockFetchModels,
  };
});

const { createRealAIClient } = await import('./real.js');

async function collectEvents(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

interface MockStreamPart {
  type: string;
  [key: string]: unknown;
}

interface MockStreamResult {
  fullStream: AsyncIterable<MockStreamPart>;
  providerMetadata: Promise<Record<string, Record<string, unknown>> | undefined>;
  totalUsage: Promise<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>;
}

/** Create a mock fullStream async iterable that yields the given parts. */
function createMockFullStream(parts: MockStreamPart[]): MockStreamResult {
  return {
    fullStream: {
      [Symbol.asyncIterator](): AsyncIterator<MockStreamPart> {
        let index = 0;
        return {
          next(): Promise<IteratorResult<MockStreamPart>> {
            if (index >= parts.length) return Promise.resolve({ done: true, value: undefined });
            const value = parts[index++]!;
            return Promise.resolve({ done: false, value });
          },
        };
      },
    },
    providerMetadata: Promise.resolve({ gateway: { generationId: 'gen-123' } }),
    totalUsage: Promise.resolve({}),
  };
}

describe('createRealAIClient', () => {
  let client: ReturnType<typeof createRealAIClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createRealAIClient({
      apiKey: 'test-api-key',
      publicModelsUrl: 'https://test.example/v1/models',
    });
  });

  describe('factory', () => {
    it('returns a client with isMock set to false', () => {
      expect(client.isMock).toBe(false);
    });
  });

  describe('text streaming', () => {
    it('calls streamText with ZDR provider options', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hello' },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await collectEvents(client.stream(request));

      expect(mockStreamText).toHaveBeenCalledTimes(1);
      const callArgs = mockStreamText.mock.calls[0]![0]!;
      expect(callArgs.providerOptions).toEqual({
        gateway: { zeroDataRetention: true },
      });
    });

    it('passes the model via gateway provider', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await collectEvents(client.stream(request));

      expect(mockGatewayInstance.__call).toHaveBeenCalledWith('anthropic/claude-sonnet-4.6');
    });

    it('yields text-delta events from streamText text-delta parts', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hello' },
          { type: 'text-delta', text: ' world' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const events = await collectEvents(client.stream(request));
      const deltas = events.filter((e) => e.kind === 'text-delta');

      expect(deltas).toEqual([
        { kind: 'text-delta', content: 'Hello' },
        { kind: 'text-delta', content: ' world' },
      ]);
    });

    it('throws loudly when gateway metadata is present but generationId is missing (schema drift guard)', async () => {
      // The Vercel AI Gateway docs declare
      // `providerMetadata.gateway.generationId: string`. If a future SDK
      // version renames or removes that field, our cost-lookup pipeline
      // would silently produce a request with `id: undefined` and
      // mis-attribute generation costs. Detect drift loudly here so
      // upgrades cannot ship without updating the schema and resolver.
      mockStreamText.mockReturnValue(
        Object.assign(
          createMockFullStream([
            { type: 'text-delta', text: 'Hi' },
            { type: 'finish', finishReason: 'stop' },
          ]),
          {
            // gateway namespace exists, but the expected `generationId`
            // field has been renamed (simulating SDK drift).
            providerMetadata: Promise.resolve({
              gateway: { generation_id: 'gen-abc-123' },
            }),
            totalUsage: Promise.resolve({}),
          }
        )
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(/generationId missing/i);
    });

    it('yields a finish event with usage and generation info from providerMetadata', async () => {
      mockStreamText.mockReturnValue(
        Object.assign(
          createMockFullStream([
            { type: 'text-delta', text: 'Hi' },
            { type: 'finish', finishReason: 'stop' },
          ]),
          {
            providerMetadata: Promise.resolve({
              gateway: { generationId: 'gen-abc-123' },
            }),
            totalUsage: Promise.resolve({ inputTokens: 50, outputTokens: 25, totalTokens: 75 }),
          }
        )
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const events = await collectEvents(client.stream(request));
      const finish = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'finish' }> => e.kind === 'finish'
      );

      expect(finish).toBeDefined();
      expect(finish!.providerMetadata?.generationId).toBe('gen-abc-123');
      expect(finish!.providerMetadata?.usage?.inputTokens).toBe(50);
      expect(finish!.providerMetadata?.usage?.outputTokens).toBe(25);
    });

    it('attaches perplexitySearch tool when webSearchEnabled=true', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Search for X' }],
        webSearchEnabled: true,
      };

      await collectEvents(client.stream(request));

      const callArgs = mockStreamText.mock.calls[0]![0]!;
      expect(callArgs.tools).toBeDefined();
      expect(callArgs.tools.perplexitySearch).toBeDefined();
      expect(mockPerplexitySearchTool).toHaveBeenCalled();
      // stopWhen caps the tool-call loop at MAX_SEARCH_TOOL_CALLS.
      expect(callArgs.stopWhen).toEqual({ __mockStopWhen: 10 });
      expect(mockStepCountIs).toHaveBeenCalledWith(10);
    });

    it('does NOT attach search tools when webSearchEnabled is false or undefined', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      await collectEvents(client.stream(request));

      const callArgs = mockStreamText.mock.calls[0]![0]!;
      expect(callArgs.tools).toBeUndefined();
      expect(callArgs.stopWhen).toBeUndefined();
    });

    it('passes maxOutputTokens directly to streamText (v6 option name)', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
        maxOutputTokens: 500,
      };

      await collectEvents(client.stream(request));

      const callArgs = mockStreamText.mock.calls[0]![0]!;
      expect(callArgs.maxOutputTokens).toBe(500);
      expect(callArgs.maxTokens).toBeUndefined();
    });

    it('converts AIMessage[] to the ai SDK message format', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Ok' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      };

      await collectEvents(client.stream(request));

      const callArgs = mockStreamText.mock.calls[0]![0]!;
      expect(callArgs.system).toBe('You are helpful.');
      // Non-system messages passed as messages array
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ]);
    });

    it('converts image content parts using mediaType (AI SDK v6 ImagePart shape)', async () => {
      // AI SDK v6 ImagePart (re-exported from @ai-sdk/provider-utils) declares
      // the field as `mediaType?: string`, NOT `mimeType`. A regression that
      // reverts to `mimeType` would silently break image inputs at runtime
      // because the gateway would not recognize the field. This test guards
      // against that drift by asserting the converted shape on the wire.
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Ok' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              { type: 'image', data: imageBytes, mimeType: 'image/png' },
            ],
          },
        ],
      };

      await collectEvents(client.stream(request));

      const callArgs = mockStreamText.mock.calls[0]![0]!;
      const userMessage = callArgs.messages[0];
      expect(userMessage.role).toBe('user');
      const parts = userMessage.content as { type: string; [key: string]: unknown }[];
      const imagePart = parts.find((p) => p.type === 'image');
      expect(imagePart).toBeDefined();
      expect(imagePart!['image']).toEqual(imageBytes);
      // The AI SDK v6 field is `mediaType`, not `mimeType`.
      expect(imagePart!['mediaType']).toBe('image/png');
      expect(imagePart!['mimeType']).toBeUndefined();
    });
  });

  describe('image generation', () => {
    it('calls generateImage with ZDR and yields media events', async () => {
      const mockImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      mockGenerateImage.mockResolvedValue({
        images: [{ uint8Array: mockImageBytes, mediaType: 'image/png' }],
        usage: {},
        providerMetadata: { gateway: { generationId: 'img-gen-1' } },
      });

      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A sunset',
        aspectRatio: '16:9',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
      expect(mockGenerateImage).toHaveBeenCalledTimes(1);

      const callArgs = mockGenerateImage.mock.calls[0]![0]!;
      expect(callArgs.providerOptions).toEqual({
        gateway: { zeroDataRetention: true },
      });
      expect(callArgs.prompt).toBe('A sunset');
      expect(callArgs.aspectRatio).toBe('16:9');
    });

    it('throws when the SDK returns an empty images array', async () => {
      mockGenerateImage.mockResolvedValue({
        images: [],
        usage: {},
        providerMetadata: {},
      });

      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'Test',
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(
        /empty image generation result/i
      );
    });

    it('reads file.mediaType (not mimeType) from the GeneratedFile', async () => {
      const mockImageBytes = new Uint8Array([1, 2, 3]);
      mockGenerateImage.mockResolvedValue({
        // No `mimeType` — only `mediaType`. We're confirming the code path
        // does not silently fall back to a default.
        images: [{ uint8Array: mockImageBytes, mediaType: 'image/webp' }],
        usage: {},
        providerMetadata: {},
      });

      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'Test',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find((e) => e.kind === 'media-done');

      expect(done).toBeDefined();
      if (done?.kind === 'media-done') {
        expect(done.mimeType).toBe('image/webp');
      }
    });

    it('emits media-done with bytes and dimensions from the image result', async () => {
      const mockImageBytes = new Uint8Array([1, 2, 3, 4]);
      mockGenerateImage.mockResolvedValue({
        images: [{ uint8Array: mockImageBytes, mediaType: 'image/png' }],
        usage: {},
        providerMetadata: {},
      });

      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'Test',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find((e) => e.kind === 'media-done');

      expect(done).toBeDefined();
      if (done?.kind === 'media-done') {
        expect(done.bytes).toEqual(mockImageBytes);
        expect(done.mimeType).toBe('image/png');
      }
    });
  });

  describe('video generation', () => {
    it('calls experimental_generateVideo with ZDR and yields media events', async () => {
      const mockVideoBytes = new Uint8Array([0x00, 0x00, 0x00, 0x14]);
      mockGenerateVideo.mockResolvedValue({
        videos: [{ uint8Array: mockVideoBytes, mediaType: 'video/mp4' }],
        providerMetadata: { gateway: { generationId: 'vid-gen-1' } },
      });

      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A wave',
        aspectRatio: '16:9',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
      expect(mockGenerateVideo).toHaveBeenCalledTimes(1);

      const callArgs = mockGenerateVideo.mock.calls[0]![0]!;
      expect(callArgs.providerOptions).toEqual({
        gateway: { zeroDataRetention: true },
      });
    });

    it('uses gateway.video() (not videoModel) to resolve the model', async () => {
      const mockVideoBytes = new Uint8Array([0x00]);
      mockGenerateVideo.mockResolvedValue({
        videos: [{ uint8Array: mockVideoBytes, mediaType: 'video/mp4' }],
        providerMetadata: {},
      });

      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A wave',
      };

      await collectEvents(client.stream(request));

      expect(mockGatewayInstance.video).toHaveBeenCalledWith('google/veo-3.1');
    });

    it('throws when the SDK returns an empty videos array', async () => {
      mockGenerateVideo.mockResolvedValue({
        videos: [],
        providerMetadata: {},
      });

      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A wave',
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(
        /empty video generation result/i
      );
    });
  });

  describe('audio generation', () => {
    it('throws an explicit "not yet supported" error when invoked', async () => {
      const request: AudioRequest = {
        modality: 'audio',
        model: 'openai/tts-1',
        prompt: 'Hello, world.',
        format: 'mp3',
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(
        /audio output is not yet supported by the AI Gateway/i
      );
    });
  });

  // ZDR enforcement — generic boundary check
  //
  // The whole point of `real.ts` over `mock.ts` is that ZDR is enforced at the
  // SDK boundary on EVERY modality path. This block uses the same mocks the
  // per-modality cases above use, but asserts ZDR generically — adding a new
  // modality and forgetting `providerOptions: ZDR_PROVIDER_OPTIONS` should
  // immediately fail this test.
  describe('ZDR enforcement at the SDK boundary', () => {
    const EXPECTED_ZDR = { gateway: { zeroDataRetention: true } };

    it('text streaming sets ZDR providerOptions on every streamText call', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      await collectEvents(
        client.stream({
          modality: 'text',
          model: 'anthropic/claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      );

      expect(mockStreamText).toHaveBeenCalledTimes(1);
      const callArgs = mockStreamText.mock.calls[0]![0]!;
      expect(callArgs.providerOptions).toEqual(EXPECTED_ZDR);
    });

    it('image generation sets ZDR providerOptions on every generateImage call', async () => {
      mockGenerateImage.mockResolvedValue({
        images: [{ uint8Array: new Uint8Array([0]), mediaType: 'image/png' }],
        usage: {},
        providerMetadata: {},
      });

      await collectEvents(
        client.stream({
          modality: 'image',
          model: 'google/imagen-4',
          prompt: 'A cat',
        })
      );

      expect(mockGenerateImage).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerateImage.mock.calls[0]![0]!;
      expect(callArgs.providerOptions).toEqual(EXPECTED_ZDR);
    });

    it('video generation sets ZDR providerOptions on every experimental_generateVideo call', async () => {
      mockGenerateVideo.mockResolvedValue({
        videos: [{ uint8Array: new Uint8Array([0]), mediaType: 'video/mp4' }],
        providerMetadata: {},
      });

      await collectEvents(
        client.stream({
          modality: 'video',
          model: 'google/veo-3.1',
          prompt: 'A wave',
        })
      );

      expect(mockGenerateVideo).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerateVideo.mock.calls[0]![0]!;
      expect(callArgs.providerOptions).toEqual(EXPECTED_ZDR);
    });

    it('every modality that reaches the SDK has ZDR set (regression guard)', async () => {
      // Reset and run all enabled modality paths back-to-back. If a NEW modality
      // is added that hits the SDK without `providerOptions: ZDR_PROVIDER_OPTIONS`,
      // this assertion will need updating — that update should also remind the
      // implementer to add ZDR to the new path.
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );
      mockGenerateImage.mockResolvedValue({
        images: [{ uint8Array: new Uint8Array([0]), mediaType: 'image/png' }],
        usage: {},
        providerMetadata: {},
      });
      mockGenerateVideo.mockResolvedValue({
        videos: [{ uint8Array: new Uint8Array([0]), mediaType: 'video/mp4' }],
        providerMetadata: {},
      });

      await collectEvents(
        client.stream({
          modality: 'text',
          model: 'anthropic/claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      );
      await collectEvents(
        client.stream({
          modality: 'image',
          model: 'google/imagen-4',
          prompt: 'A cat',
        })
      );
      await collectEvents(
        client.stream({
          modality: 'video',
          model: 'google/veo-3.1',
          prompt: 'A wave',
        })
      );

      // Aggregate every SDK call recorded across the three mocks. Each must
      // have providerOptions exactly equal to the ZDR shape — no overrides
      // and no missing fields.
      const everySdkCallArgs = [
        ...mockStreamText.mock.calls.map((call) => call[0]),
        ...mockGenerateImage.mock.calls.map((call) => call[0]),
        ...mockGenerateVideo.mock.calls.map((call) => call[0]),
      ];

      expect(everySdkCallArgs.length).toBe(3);
      for (const args of everySdkCallArgs) {
        expect(args.providerOptions).toEqual(EXPECTED_ZDR);
      }
    });

    it('ZDR_PROVIDER_OPTIONS shape stays paired with the mock-side `zdrEnforced` flag (consistency guard)', () => {
      // The mock client tags every recorded request with `zdrEnforced: true`
      // so unit-level tests can detect a regression on either side. This
      // assertion pins the "ground truth" — if `gateway.zeroDataRetention`
      // ever flips to `false` here, the mock's `zdrEnforced: true` would be
      // a lie. Failing both at the same time forces the implementer to
      // confront the discrepancy instead of silently letting one drift.
      expect(EXPECTED_ZDR.gateway.zeroDataRetention).toBe(true);
    });
  });

  describe('listModels', () => {
    it('delegates to fetchModels and maps RawModel to ModelInfo per modality', async () => {
      mockFetchModels.mockResolvedValue([
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          description: 'Fast model',
          modality: 'text',
          context_length: 200_000,
          pricing: { prompt: '0.000003', completion: '0.000015' },
          supported_parameters: [],
          created: 0,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'google/imagen-4.0-generate-001',
          name: 'Imagen 4',
          description: 'Image generation',
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
          description: 'Video generation',
          modality: 'video',
          context_length: 0,
          pricing: {
            prompt: '0',
            completion: '0',
            per_second_by_resolution: { '720p': '0.4', '1080p': '0.4' },
          },
          supported_parameters: [],
          created: 0,
          architecture: { input_modalities: ['video'], output_modalities: ['video'] },
        },
      ]);

      const models = await client.listModels();

      expect(models.length).toBe(3);
      expect(models[0]!.id).toBe('anthropic/claude-sonnet-4.6');
      expect(models[0]!.modality).toBe('text');
      if (models[0]!.pricing.kind === 'token') {
        expect(models[0]!.pricing.inputPerToken).toBeCloseTo(0.000_003, 9);
      }
      expect(models[1]!.modality).toBe('image');
      if (models[1]!.pricing.kind === 'image') {
        expect(models[1]!.pricing.perImage).toBeCloseTo(0.04, 6);
      }
      expect(models[2]!.modality).toBe('video');
      if (models[2]!.pricing.kind === 'video') {
        expect(models[2]!.pricing.perSecondByResolution).toEqual({ '720p': 0.4, '1080p': 0.4 });
      }
    });

    it('handles audio modality and throws on unrecognized modality (assertNever guard)', async () => {
      // Audio modality returns audio pricing kind with perSecond 0
      mockFetchModels.mockResolvedValue([
        {
          id: 'openai/whisper-1',
          name: 'Whisper',
          description: 'Audio',
          modality: 'audio',
          context_length: 0,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: [],
          created: 0,
          architecture: { input_modalities: ['audio'], output_modalities: ['audio'] },
        },
      ]);

      const audioModels = await client.listModels();
      expect(audioModels[0]!.modality).toBe('audio');
      expect(audioModels[0]!.pricing.kind).toBe('audio');

      // Unknown modality (cast bypasses type system): assertNever throws.
      mockFetchModels.mockResolvedValue([
        {
          id: 'rogue/model',
          name: 'Rogue',
          description: 'Unknown',
          modality: 'rogue' as 'text',
          context_length: 0,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: [],
          created: 0,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ]);

      await expect(client.listModels()).rejects.toThrow(/exhaustiveness/i);
    });
  });

  describe('listRawModels', () => {
    it('returns the merged RawModel list straight from fetchModels', async () => {
      const raw = [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          description: 'Fast model',
          modality: 'text' as const,
          context_length: 200_000,
          pricing: { prompt: '0.000003', completion: '0.000015' },
          supported_parameters: [],
          created: 0,
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
        },
      ];
      mockFetchModels.mockResolvedValue(raw);

      const result = await client.listRawModels();

      expect(result).toEqual(raw);
      expect(mockFetchModels).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        publicModelsUrl: 'https://test.example/v1/models',
      });
    });

    it('listModels reuses listRawModels (single fetch path)', async () => {
      mockFetchModels.mockResolvedValue([
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          description: 'Fast model',
          modality: 'text',
          context_length: 200_000,
          pricing: { prompt: '0.000003', completion: '0.000015' },
          supported_parameters: [],
          created: 0,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ]);

      mockFetchModels.mockClear();
      await client.listModels();
      // listModels delegates to listRawModels, which calls fetchModels exactly once.
      expect(mockFetchModels).toHaveBeenCalledTimes(1);
    });
  });

  describe('getModel', () => {
    it('returns the model matching the given id', async () => {
      mockFetchModels.mockResolvedValue([
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Claude Sonnet 4.6',
          description: 'Fast model',
          modality: 'text',
          context_length: 200_000,
          pricing: { prompt: '0.000003', completion: '0.000015' },
          supported_parameters: [],
          created: 0,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ]);

      const model = await client.getModel('anthropic/claude-sonnet-4.6');
      expect(model.id).toBe('anthropic/claude-sonnet-4.6');
    });

    it('throws for an unknown model id', async () => {
      mockFetchModels.mockResolvedValue([]);

      await expect(client.getModel('nonexistent/model')).rejects.toThrow('Model not found');
    });
  });

  describe('getGenerationStats', () => {
    it('calls gateway.getGenerationInfo and returns costUsd', async () => {
      mockGatewayInstance.getGenerationInfo.mockResolvedValue({
        totalCost: 0.0042,
      });

      const stats = await client.getGenerationStats('gen-abc-123');

      expect(mockGatewayInstance.getGenerationInfo).toHaveBeenCalledWith({
        id: 'gen-abc-123',
      });
      expect(stats.costUsd).toBe(0.0042);
    });
  });

  describe('evidence recording', () => {
    interface FakeDb {
      insert: ReturnType<typeof vi.fn>;
    }

    function createFakeDb(): FakeDb {
      const values = vi.fn(() => Promise.resolve([]));
      return {
        insert: vi.fn(() => ({ values })),
      };
    }

    it('records evidence after a successful listModels call when isCI=true', async () => {
      const db = createFakeDb();
      const evidenceClient = createRealAIClient({
        apiKey: 'test-api-key',
        publicModelsUrl: 'https://test.example/v1/models',
        evidence: { db: db as never, isCI: true },
      });
      mockFetchModels.mockResolvedValue([]);

      await evidenceClient.listModels();

      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('records evidence after a successful stream when isCI=true', async () => {
      const db = createFakeDb();
      const evidenceClient = createRealAIClient({
        apiKey: 'test-api-key',
        publicModelsUrl: 'https://test.example/v1/models',
        evidence: { db: db as never, isCI: true },
      });
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', text: 'Hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: {} },
        ])
      );

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };
      await collectEvents(evidenceClient.stream(request));

      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('records evidence after a successful getGenerationStats call when isCI=true', async () => {
      const db = createFakeDb();
      const evidenceClient = createRealAIClient({
        apiKey: 'test-api-key',
        publicModelsUrl: 'https://test.example/v1/models',
        evidence: { db: db as never, isCI: true },
      });
      mockGatewayInstance.getGenerationInfo.mockResolvedValue({ totalCost: 0.01 });

      await evidenceClient.getGenerationStats('gen-xyz');

      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('does not record evidence when isCI=false', async () => {
      const db = createFakeDb();
      const evidenceClient = createRealAIClient({
        apiKey: 'test-api-key',
        publicModelsUrl: 'https://test.example/v1/models',
        evidence: { db: db as never, isCI: false },
      });
      mockFetchModels.mockResolvedValue([]);

      await evidenceClient.listModels();

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does not record evidence when evidence config is omitted', async () => {
      const plainClient = createRealAIClient({
        apiKey: 'test-api-key',
        publicModelsUrl: 'https://test.example/v1/models',
      });
      mockFetchModels.mockResolvedValue([]);

      // Should not throw (no db to record with) and should return models normally.
      await expect(plainClient.listModels()).resolves.toEqual([]);
    });
  });

  describe('stream exhaustiveness guard', () => {
    it('throws when given an unrecognized modality (assertNever)', () => {
      const badRequest = {
        modality: 'rogue',
        model: 'rogue/model',
        prompt: 'unused',
      } as unknown as TextRequest;

      expect(() => client.stream(badRequest)).toThrow(/exhaustiveness/i);
    });
  });
});
