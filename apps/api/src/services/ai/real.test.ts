import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InferenceEvent, TextRequest, ImageRequest, VideoRequest } from './types.js';

// ---------------------------------------------------------------------------
// Module mocks — intercept ai + @ai-sdk/gateway at the module boundary
// ---------------------------------------------------------------------------

const mockStreamText = vi.fn();
const mockGenerateImage = vi.fn();
const mockGenerateVideo = vi.fn();

vi.mock('ai', () => ({
  streamText: mockStreamText,
  generateImage: mockGenerateImage,
  experimental_generateVideo: mockGenerateVideo,
}));

const mockGatewayInstance = {
  __call: vi.fn(),
  imageModel: vi.fn(),
  videoModel: vi.fn(),
  getAvailableModels: vi.fn(),
  getGenerationInfo: vi.fn(),
};

// The gateway is callable: gateway('model-id') returns a language model
const mockGateway = Object.assign(mockGatewayInstance.__call, mockGatewayInstance);

vi.mock('@ai-sdk/gateway', () => ({
  createGateway: vi.fn(() => mockGateway),
}));

// Import after mocks are defined
const { createRealAIClient } = await import('./real.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Create a mock fullStream async iterable that yields the given parts. */
function createMockFullStream(parts: { type: string; [key: string]: unknown }[]): {
  fullStream: AsyncIterable<{ type: string; [key: string]: unknown }>;
  providerMetadata: Promise<Record<string, Record<string, unknown>> | undefined>;
} {
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        for (const part of parts) {
          yield part;
        }
      },
    },
    providerMetadata: Promise.resolve({ gateway: { generationId: 'gen-123' } }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRealAIClient', () => {
  let client: ReturnType<typeof createRealAIClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createRealAIClient('test-api-key');
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
          { type: 'text-delta', textDelta: 'Hello' },
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
      const callArgs = mockStreamText.mock.calls[0][0];
      expect(callArgs.providerOptions).toEqual({
        gateway: { zeroDataRetention: true },
      });
    });

    it('passes the model via gateway provider', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', textDelta: 'Hi' },
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
          { type: 'text-delta', textDelta: 'Hello' },
          { type: 'text-delta', textDelta: ' world' },
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

    it('yields a finish event with usage and generation info from providerMetadata', async () => {
      mockStreamText.mockReturnValue({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', textDelta: 'Hi' };
            yield {
              type: 'finish',
              finishReason: 'stop',
              totalUsage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
            };
          },
        },
        providerMetadata: Promise.resolve({
          gateway: { generationId: 'gen-abc-123' },
        }),
      });

      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const events = await collectEvents(client.stream(request));
      const finish = events.find((e) => e.kind === 'finish');

      expect(finish).toBeDefined();
      expect(finish!.kind).toBe('finish');
      if (finish!.kind === 'finish') {
        expect(finish!.providerMetadata?.generationId).toBe('gen-abc-123');
        expect(finish!.providerMetadata?.usage?.inputTokens).toBe(50);
        expect(finish!.providerMetadata?.usage?.outputTokens).toBe(25);
      }
    });

    it('passes maxOutputTokens as maxTokens to streamText', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', textDelta: 'Hi' },
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

      const callArgs = mockStreamText.mock.calls[0][0];
      expect(callArgs.maxTokens).toBe(500);
    });

    it('converts AIMessage[] to the ai SDK message format', async () => {
      mockStreamText.mockReturnValue(
        createMockFullStream([
          { type: 'text-delta', textDelta: 'Ok' },
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

      const callArgs = mockStreamText.mock.calls[0][0];
      expect(callArgs.system).toBe('You are helpful.');
      // Non-system messages passed as messages array
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ]);
    });
  });

  describe('image generation', () => {
    it('calls generateImage with ZDR and yields media events', async () => {
      const mockImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      mockGenerateImage.mockResolvedValue({
        image: { uint8Array: mockImageBytes, mimeType: 'image/png' },
        images: [{ uint8Array: mockImageBytes, mimeType: 'image/png' }],
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

      const callArgs = mockGenerateImage.mock.calls[0][0];
      expect(callArgs.providerOptions).toEqual({
        gateway: { zeroDataRetention: true },
      });
      expect(callArgs.prompt).toBe('A sunset');
      expect(callArgs.aspectRatio).toBe('16:9');
    });

    it('emits media-done with bytes and dimensions from the image result', async () => {
      const mockImageBytes = new Uint8Array([1, 2, 3, 4]);
      mockGenerateImage.mockResolvedValue({
        image: { uint8Array: mockImageBytes, mimeType: 'image/png' },
        images: [{ uint8Array: mockImageBytes, mimeType: 'image/png' }],
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
        video: { uint8Array: mockVideoBytes, mimeType: 'video/mp4' },
        videos: [{ uint8Array: mockVideoBytes, mimeType: 'video/mp4' }],
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

      const callArgs = mockGenerateVideo.mock.calls[0][0];
      expect(callArgs.providerOptions).toEqual({
        gateway: { zeroDataRetention: true },
      });
    });
  });

  describe('listModels', () => {
    it('calls gateway.getAvailableModels and maps results', async () => {
      mockGatewayInstance.getAvailableModels.mockResolvedValue({
        models: [
          {
            id: 'anthropic/claude-sonnet-4.6',
            name: 'Claude Sonnet 4.6',
            description: 'Fast model',
            type: 'chat',
            provider: 'anthropic',
            contextLength: 200_000,
            pricing: { inputPerToken: '0.000003', outputPerToken: '0.000015' },
            capabilities: [],
          },
          {
            id: 'google/imagen-4',
            name: 'Imagen 4',
            description: 'Image generation',
            type: 'image',
            provider: 'google-vertex',
            pricing: { perImage: '0.04' },
            capabilities: [],
          },
        ],
      });

      const models = await client.listModels();

      expect(models.length).toBe(2);
      expect(models[0]!.id).toBe('anthropic/claude-sonnet-4.6');
      expect(models[0]!.modality).toBe('text');
      expect(models[1]!.id).toBe('google/imagen-4');
      expect(models[1]!.modality).toBe('image');
    });
  });

  describe('getModel', () => {
    it('returns the model matching the given id', async () => {
      mockGatewayInstance.getAvailableModels.mockResolvedValue({
        models: [
          {
            id: 'anthropic/claude-sonnet-4.6',
            name: 'Claude Sonnet 4.6',
            description: 'Fast model',
            type: 'chat',
            provider: 'anthropic',
            contextLength: 200_000,
            pricing: { inputPerToken: '0.000003', outputPerToken: '0.000015' },
            capabilities: [],
          },
        ],
      });

      const model = await client.getModel('anthropic/claude-sonnet-4.6');
      expect(model.id).toBe('anthropic/claude-sonnet-4.6');
    });

    it('throws for an unknown model id', async () => {
      mockGatewayInstance.getAvailableModels.mockResolvedValue({ models: [] });

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
        generationId: 'gen-abc-123',
      });
      expect(stats.costUsd).toBe(0.0042);
    });
  });
});
