import { describe, it, expect, beforeEach } from 'vitest';
import { CLASSIFIER_SYSTEM_PROMPT_MARKER } from '@hushbox/shared';
import { createMockAIClient, CANNED_IMAGE, CANNED_VIDEO } from './mock.js';
import type {
  MockAIClient,
  TextRequest,
  ImageRequest,
  VideoRequest,
  AudioRequest,
  InferenceEvent,
} from './types.js';

async function collectEvents(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('createMockAIClient', () => {
  let client: MockAIClient;

  beforeEach(() => {
    client = createMockAIClient();
    client.clearHistory();
    client.clearFailingModels();
  });

  describe('factory', () => {
    it('returns a client with isMock set to true', () => {
      expect(client.isMock).toBe(true);
    });

    it('exposes all AIClient methods', () => {
      expect(typeof client.listModels).toBe('function');
      expect(typeof client.getModel).toBe('function');
      expect(typeof client.stream).toBe('function');
      expect(typeof client.getGenerationStats).toBe('function');
    });

    it('exposes all MockAIClient test helpers', () => {
      expect(typeof client.getRequestHistory).toBe('function');
      expect(typeof client.clearHistory).toBe('function');
      expect(typeof client.addFailingModel).toBe('function');
      expect(typeof client.clearFailingModels).toBe('function');
      expect(typeof client.setClassifierResolution).toBe('function');
      expect(typeof client.setClassifierFailure).toBe('function');
    });
  });

  describe('classifier streaming', () => {
    function classifierRequest(): TextRequest {
      return {
        modality: 'text',
        model: 'cheap/c',
        messages: [
          {
            role: 'system',
            content: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nPick a model.\nAvailable: m/a, m/b`,
          },
          { role: 'user', content: '[USER START]: hello' },
        ],
      };
    }

    it('emits the configured resolution as text-deltas plus a finish event', async () => {
      client.setClassifierResolution('anthropic/claude-opus-4.6');
      const events = await collectEvents(client.stream(classifierRequest()));
      const text = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');
      expect(text).toBe('anthropic/claude-opus-4.6');
      expect(events.at(-1)?.kind).toBe('finish');
    });

    it('returns the default classifier resolution when none is configured', async () => {
      const events = await collectEvents(client.stream(classifierRequest()));
      const text = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');
      expect(text.length).toBeGreaterThan(0);
    });

    it('rejects the stream when classifier failure is set', async () => {
      client.setClassifierFailure(new Error('classifier dead'));
      await expect(collectEvents(client.stream(classifierRequest()))).rejects.toThrow(
        'classifier dead'
      );
    });

    it('clears classifier failure when set to null', async () => {
      client.setClassifierFailure(new Error('classifier dead'));
      client.setClassifierFailure(null);
      const events = await collectEvents(client.stream(classifierRequest()));
      expect(events.length).toBeGreaterThan(0);
    });

    it('does not classify when system prompt lacks the marker', async () => {
      // Plain text request — should echo the user message, not return a model id
      const request: TextRequest = {
        modality: 'text',
        model: 'm/a',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello, world!' },
        ],
      };
      client.setClassifierResolution('classifier/should-not-fire');
      const events = await collectEvents(client.stream(request));
      const text = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');
      expect(text).toBe('Echo: Hello, world!');
    });
  });

  describe('text streaming', () => {
    it('echoes the last user message content', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello, world!' },
        ],
      };

      const events = await collectEvents(client.stream(request));
      const textContent = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');

      expect(textContent).toBe('Echo: Hello, world!');
    });

    it('yields individual characters as text-delta events', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const events = await collectEvents(client.stream(request));
      const deltas = events.filter(
        (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
      );

      // Each character is a separate event
      expect(deltas.length).toBe('Echo: Hi'.length);
      for (const delta of deltas) {
        expect(delta.content.length).toBe(1);
      }
    });

    it('ends with a finish event containing a generationId (no inline cost)', async () => {
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
      expect(finish!.providerMetadata).toBeDefined();
      expect(typeof finish!.providerMetadata!.generationId).toBe('string');
    });

    it('handles missing user message gracefully', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'system', content: 'System only' }],
      };

      const events = await collectEvents(client.stream(request));
      const textContent = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');

      expect(textContent).toBe('Echo: No message');
    });

    it('uses the last user message when multiple exist', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Response' },
          { role: 'user', content: 'Second' },
        ],
      };

      const events = await collectEvents(client.stream(request));
      const textContent = events
        .filter(
          (e): e is Extract<InferenceEvent, { kind: 'text-delta' }> => e.kind === 'text-delta'
        )
        .map((e) => e.content)
        .join('');

      expect(textContent).toBe('Echo: Second');
    });
  });

  describe('image generation', () => {
    it('emits media-start, media-done, and finish events', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A cat wearing a hat',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
    });

    it('emits media-start with image mediaType and image/jpeg mimeType', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A sunset',
      };

      const events = await collectEvents(client.stream(request));
      const start = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-start' }> => e.kind === 'media-start'
      );

      expect(start).toBeDefined();
      expect(start!.mediaType).toBe('image');
      expect(start!.mimeType).toBe('image/jpeg');
    });

    it('emits media-done with non-empty JPEG bytes and 400×300 dimensions', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A mountain',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );

      expect(done).toBeDefined();
      expect(done!.bytes.length).toBeGreaterThan(0);
      expect(done!.mimeType).toBe('image/jpeg');
      expect(done!.width).toBe(400);
      expect(done!.height).toBe(300);
    });

    it('canned image bytes start with the JPEG SOI marker', () => {
      // JPEG files always begin with FF D8 FF — guards the fixture import
      // against accidental corruption / wrong file type.
      expect(CANNED_IMAGE.length).toBeGreaterThan(0);
      expect(CANNED_IMAGE[0]).toBe(0xff);
      expect(CANNED_IMAGE[1]).toBe(0xd8);
      expect(CANNED_IMAGE[2]).toBe(0xff);
    });

    it('emits finish with a generationId (no inline cost)', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A forest',
      };

      const events = await collectEvents(client.stream(request));
      const finish = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'finish' }> => e.kind === 'finish'
      );

      expect(finish).toBeDefined();
      expect(finish!.providerMetadata).toBeDefined();
      expect(typeof finish!.providerMetadata!.generationId).toBe('string');
    });
  });

  describe('video generation', () => {
    it('emits media-start, media-done, and finish events', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A flying bird',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
    });

    it('emits media-start with video mediaType and video/mp4 mimeType', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A wave',
      };

      const events = await collectEvents(client.stream(request));
      const start = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-start' }> => e.kind === 'media-start'
      );

      expect(start).toBeDefined();
      expect(start!.mediaType).toBe('video');
      expect(start!.mimeType).toBe('video/mp4');
    });

    it('emits media-done with bytes and durationMs matching the canned video', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'Ocean',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );

      expect(done).toBeDefined();
      expect(done!.bytes.length).toBeGreaterThan(0);
      expect(done!.mimeType).toBe('video/mp4');
      expect(done!.durationMs).toBe(5000);
    });

    it('canned video bytes carry the ISO BMFF ftyp box at offset 4', () => {
      // ISO BMFF: bytes [0..3] = box size (big-endian); bytes [4..7] = box type.
      // For any valid MP4 the first box must be `ftyp` (= 66 74 79 70).
      expect(CANNED_VIDEO.length).toBeGreaterThan(0);
      expect(CANNED_VIDEO[4]).toBe(0x66); // f
      expect(CANNED_VIDEO[5]).toBe(0x74); // t
      expect(CANNED_VIDEO[6]).toBe(0x79); // y
      expect(CANNED_VIDEO[7]).toBe(0x70); // p
    });
  });

  describe('audio generation', () => {
    it('emits media-start, media-done, and finish events', async () => {
      const request: AudioRequest = {
        modality: 'audio',
        model: 'some/audio-model',
        prompt: 'A soothing melody',
      };

      const events = await collectEvents(client.stream(request));
      const kinds = events.map((e) => e.kind);

      expect(kinds).toEqual(['media-start', 'media-done', 'finish']);
    });

    it('emits media-done with audio/mpeg mimeType and durationMs', async () => {
      const request: AudioRequest = {
        modality: 'audio',
        model: 'some/audio-model',
        prompt: 'Birds chirping',
      };

      const events = await collectEvents(client.stream(request));
      const done = events.find(
        (e): e is Extract<InferenceEvent, { kind: 'media-done' }> => e.kind === 'media-done'
      );

      expect(done).toBeDefined();
      expect(done!.bytes.length).toBeGreaterThan(0);
      expect(done!.mimeType).toBe('audio/mpeg');
      expect(done!.durationMs).toBeGreaterThan(0);
    });
  });

  describe('request history', () => {
    it('starts with empty history', () => {
      expect(client.getRequestHistory()).toEqual([]);
    });

    it('records text requests', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await collectEvents(client.stream(request));

      const history = client.getRequestHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject(request);
    });

    it('records image requests', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'Test image',
      };

      await collectEvents(client.stream(request));

      const history = client.getRequestHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject(request);
    });

    it('records multiple requests in order', async () => {
      const textRequest: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'First' }],
      };
      const imageRequest: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'Second',
      };

      await collectEvents(client.stream(textRequest));
      await collectEvents(client.stream(imageRequest));

      const history = client.getRequestHistory();
      expect(history).toHaveLength(2);
      expect(history[0]!.modality).toBe('text');
      expect(history[1]!.modality).toBe('image');
    });

    it('returns defensive copies', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await collectEvents(client.stream(request));

      const history1 = client.getRequestHistory();
      const history2 = client.getRequestHistory();
      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });

    it('clears history', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await collectEvents(client.stream(request));
      expect(client.getRequestHistory()).toHaveLength(1);

      client.clearHistory();
      expect(client.getRequestHistory()).toEqual([]);
    });
  });

  describe('zdrEnforced tracking', () => {
    it('records zdrEnforced=true on text requests', async () => {
      const request: TextRequest = {
        modality: 'text',
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'Test' }],
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on image requests', async () => {
      const request: ImageRequest = {
        modality: 'image',
        model: 'google/imagen-4',
        prompt: 'A sunset',
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on video requests', async () => {
      const request: VideoRequest = {
        modality: 'video',
        model: 'google/veo-3.1',
        prompt: 'A wave',
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on audio requests', async () => {
      const request: AudioRequest = {
        modality: 'audio',
        model: 'openai/tts-1',
        prompt: 'Hello.',
      };
      await collectEvents(client.stream(request));
      const history = client.getRequestHistory();
      expect(history[0]?.zdrEnforced).toBe(true);
    });

    it('records zdrEnforced=true on classifier (Smart Model) calls', async () => {
      const classifierRequest: TextRequest = {
        modality: 'text',
        model: 'cheap/c',
        messages: [
          {
            role: 'system',
            content: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nPick a model.\n- a/x — A.\n- b/y — B.`,
          },
          { role: 'user', content: '[USER START]: hi' },
        ],
      };
      await collectEvents(client.stream(classifierRequest));
      const history = client.getRequestHistory();
      expect(history).toHaveLength(1);
      expect(history[0]?.zdrEnforced).toBe(true);
    });
  });

  describe('failing models', () => {
    it('throws for a model added to the failing set', async () => {
      client.addFailingModel('bad/model');

      const request: TextRequest = {
        modality: 'text',
        model: 'bad/model',
        messages: [{ role: 'user', content: 'Test' }],
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(
        'Model bad/model is unavailable'
      );
    });

    it('does not throw for models not in the failing set', async () => {
      client.addFailingModel('bad/model');

      const request: TextRequest = {
        modality: 'text',
        model: 'good/model',
        messages: [{ role: 'user', content: 'Test' }],
      };

      const events = await collectEvents(client.stream(request));
      expect(events.length).toBeGreaterThan(0);
    });

    it('clears failing models', async () => {
      client.addFailingModel('bad/model');
      client.clearFailingModels();

      const request: TextRequest = {
        modality: 'text',
        model: 'bad/model',
        messages: [{ role: 'user', content: 'Test' }],
      };

      const events = await collectEvents(client.stream(request));
      expect(events.length).toBeGreaterThan(0);
    });

    it('throws for image requests to failing models', async () => {
      client.addFailingModel('bad/image-model');

      const request: ImageRequest = {
        modality: 'image',
        model: 'bad/image-model',
        prompt: 'Test',
      };

      await expect(collectEvents(client.stream(request))).rejects.toThrow(
        'Model bad/image-model is unavailable'
      );
    });
  });

  describe('listModels', () => {
    it('returns a non-empty array of ModelInfo', async () => {
      const models = await client.listModels();
      expect(models.length).toBeGreaterThan(0);
    });

    it('returns models with all required fields', async () => {
      const models = await client.listModels();
      for (const model of models) {
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
        expect(typeof model.provider).toBe('string');
        expect(['text', 'image', 'audio', 'video']).toContain(model.modality);
        expect(typeof model.description).toBe('string');
        expect(model.pricing).toBeDefined();
        expect(model.capabilities).toBeDefined();
        expect(typeof model.isZdr).toBe('boolean');
      }
    });

    it('includes at least one text and one image model', async () => {
      const models = await client.listModels();
      const textModels = models.filter((m) => m.modality === 'text');
      const imageModels = models.filter((m) => m.modality === 'image');
      expect(textModels.length).toBeGreaterThan(0);
      expect(imageModels.length).toBeGreaterThan(0);
    });
  });

  describe('listRawModels', () => {
    it('returns a non-empty RawModel array with the gateway-shaped pricing fields', async () => {
      const raw = await client.listRawModels();
      expect(raw.length).toBeGreaterThan(0);
      for (const model of raw) {
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
        expect(['text', 'image', 'audio', 'video']).toContain(model.modality);
        expect(typeof model.context_length).toBe('number');
        expect(typeof model.pricing.prompt).toBe('string');
        expect(typeof model.pricing.completion).toBe('string');
        expect(Array.isArray(model.supported_parameters)).toBe(true);
        expect(Array.isArray(model.architecture.input_modalities)).toBe(true);
        expect(Array.isArray(model.architecture.output_modalities)).toBe(true);
      }
    });

    it('exposes the same id set as listModels — single source of truth', async () => {
      const [raw, info] = await Promise.all([client.listRawModels(), client.listModels()]);
      const rawIds = raw.map((m) => m.id).toSorted((a, b) => a.localeCompare(b));
      const infoIds = info.map((m) => m.id).toSorted((a, b) => a.localeCompare(b));
      expect(rawIds).toEqual(infoIds);
    });

    it('returns a defensive copy — mutating the result does not affect future calls', async () => {
      const first = await client.listRawModels();
      first.length = 0;
      const second = await client.listRawModels();
      expect(second.length).toBeGreaterThan(0);
    });

    it('feeds processModels with at least one premium text model so the tier gate has something to lock', async () => {
      const { processModels } = await import('@hushbox/shared/models');
      const raw = await client.listRawModels();
      const { premiumIds } = processModels(raw);
      expect(premiumIds.length).toBeGreaterThan(0);
    });

    it('exposes at least 5 non-premium text models so the multi-model max-selection flow has enough options', async () => {
      const { processModels } = await import('@hushbox/shared/models');
      const raw = await client.listRawModels();
      const { models, premiumIds } = processModels(raw);
      const nonPremiumText = models.filter(
        (m) => m.modality === 'text' && !premiumIds.includes(m.id)
      );
      expect(nonPremiumText.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('getModel', () => {
    it('returns the model matching the given id', async () => {
      const models = await client.listModels();
      const firstModel = models[0]!;
      const found = await client.getModel(firstModel.id);
      expect(found.id).toBe(firstModel.id);
    });

    it('throws for an unknown model id', async () => {
      await expect(client.getModel('nonexistent/model')).rejects.toThrow();
    });
  });

  describe('getGenerationStats', () => {
    it('returns deterministic cost for any generation id', async () => {
      const stats = await client.getGenerationStats('mock-gen-123');
      expect(typeof stats.costUsd).toBe('number');
      expect(stats.costUsd).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Exhaustiveness guard for the synchronous stream() switch — protects
  // against a future caller losing strict typing (via `as` cast) and silently
  // landing in a no-op branch. Mirrors the pattern in modality-strategies.test.ts.
  // ---------------------------------------------------------------------------
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
