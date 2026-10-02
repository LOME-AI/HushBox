import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TEST_DAY_START } from '../testing/test-time.ts';
import { utcDayKey } from '../utils/date.ts';
import {
  ChatHistoryMessage,
  FilePart,
  FINISH_REASONS,
  InferenceEvent,
  InferenceRequest,
  InputPart,
  MediaRef,
  ProviderMetadata,
  TOOL_ERROR_REASONS,
  Usage,
} from './inference.ts';
import type { FilePartMapper } from './inference.ts';

const ref = { ref: 'inputs/run-1/u1', mimeType: 'image/png', byteLength: 64 };
const utcDay = utcDayKey(new Date(TEST_DAY_START));

describe('MediaRef', () => {
  it('parses a media reference', () => {
    expect(MediaRef.parse(ref)).toEqual(ref);
  });

  it('rejects an empty ref', () => {
    expect(MediaRef.safeParse({ ...ref, ref: '' }).success).toBe(false);
  });
});

describe('InputPart', () => {
  it('parses inline text', () => {
    expect(InputPart.parse({ modality: 'text', text: 'hi' })).toEqual({
      modality: 'text',
      text: 'hi',
    });
  });

  it.each(['image', 'audio', 'video'] as const)('parses a %s part by MediaRef', (modality) => {
    expect(InputPart.parse({ modality, ref })).toEqual({ modality, ref });
  });

  it('rejects an embedding input part (not an input modality)', () => {
    expect(InputPart.safeParse({ modality: 'embedding', ref }).success).toBe(false);
  });

  it('rejects inline bytes on a media part (media rides by ref)', () => {
    expect(InputPart.safeParse({ modality: 'image', bytes: new Uint8Array([1]) }).success).toBe(
      false
    );
  });
});

describe('InferenceRequest', () => {
  it('parses the request shape', () => {
    const request = {
      model: 'openai/gpt-5',
      inputs: [{ modality: 'text', text: 'hello' }],
      parameters: { temperature: 1 },
      outputs: ['text'],
      utcDay,
    };
    expect(InferenceRequest.parse(request)).toEqual(request);
  });

  it('rejects an unknown output modality', () => {
    expect(
      InferenceRequest.safeParse({
        model: 'm',
        inputs: [],
        parameters: {},
        outputs: ['speech'],
        utcDay,
      }).success
    ).toBe(false);
  });

  it('parses a request carrying role-tagged conversation history', () => {
    const request = {
      model: 'openai/gpt-5',
      inputs: [{ modality: 'text', text: 'and now?' }],
      parameters: {},
      outputs: ['text'],
      utcDay,
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    };
    expect(InferenceRequest.parse(request)).toEqual(request);
  });

  it('parses a request without history (prior single-message shape)', () => {
    const request = {
      model: 'openai/gpt-5',
      inputs: [{ modality: 'text', text: 'hello' }],
      parameters: {},
      outputs: ['text'],
      utcDay,
    };
    expect(InferenceRequest.parse(request)).not.toHaveProperty('history');
  });

  it('rejects a request carrying no day', () => {
    expect(
      InferenceRequest.safeParse({
        model: 'openai/gpt-5',
        inputs: [{ modality: 'text', text: 'hello' }],
        parameters: {},
        outputs: ['text'],
      }).success
    ).toBe(false);
  });

  it('rejects a day that is not a calendar date', () => {
    expect(
      InferenceRequest.safeParse({
        model: 'openai/gpt-5',
        inputs: [{ modality: 'text', text: 'hello' }],
        parameters: {},
        outputs: ['text'],
        utcDay: new Date(TEST_DAY_START).toISOString(),
      }).success
    ).toBe(false);
  });

  it('rejects a history message with an unknown role', () => {
    expect(ChatHistoryMessage.safeParse({ role: 'system', content: 'x' }).success).toBe(false);
  });

  it('rejects a history message with empty content', () => {
    expect(ChatHistoryMessage.safeParse({ role: 'user', content: '' }).success).toBe(false);
  });

  it('accepts a history ending in either role (no alternation constraint)', () => {
    const history = [
      { role: 'assistant', content: 'unprompted' },
      { role: 'assistant', content: 'again' },
    ];
    expect(z.array(ChatHistoryMessage).parse(history)).toEqual(history);
  });
});

describe('Usage / ProviderMetadata', () => {
  it('parses token usage', () => {
    expect(Usage.parse({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('rejects negative token counts', () => {
    expect(Usage.safeParse({ inputTokens: -1, outputTokens: 0 }).success).toBe(false);
  });

  it('carries finishReason — including length (billable truncation lives in consumers)', () => {
    const metadata = {
      generationId: 'gen-1',
      usage: { inputTokens: 1, outputTokens: 0 },
      finishReason: 'length',
    };
    expect(ProviderMetadata.parse(metadata)).toEqual(metadata);
  });

  it('carries an optional inline provider cost (billing truth, raw USD)', () => {
    const metadata = {
      generationId: 'gen-1',
      usage: { inputTokens: 1, outputTokens: 2 },
      finishReason: 'stop',
      providerCostUsd: 0.000_42,
    };
    expect(ProviderMetadata.parse(metadata)).toEqual(metadata);
  });

  it('omits the provider cost when absent (settlement falls back to the estimate)', () => {
    const parsed = ProviderMetadata.parse({
      usage: { inputTokens: 1, outputTokens: 0 },
      finishReason: 'stop',
    });
    expect('providerCostUsd' in parsed).toBe(false);
  });

  it('carries the endpoint that served a call reporting it only at its end', () => {
    const metadata = {
      usage: { inputTokens: 1, outputTokens: 2 },
      finishReason: 'stop',
      servedBy: 'mock',
    };
    expect(ProviderMetadata.parse(metadata)).toEqual(metadata);
  });

  it('rejects an empty serving endpoint', () => {
    expect(
      ProviderMetadata.safeParse({
        usage: { inputTokens: 1, outputTokens: 2 },
        finishReason: 'stop',
        servedBy: '',
      }).success
    ).toBe(false);
  });

  it('rejects an unknown finishReason', () => {
    expect(
      ProviderMetadata.safeParse({
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'gave-up',
      }).success
    ).toBe(false);
  });

  it("mirrors the AI SDK's FinishReason exactly, in order (unmapped reasons arrive as `other`)", () => {
    expect(FINISH_REASONS).toEqual([
      'stop',
      'length',
      'content-filter',
      'tool-calls',
      'error',
      'other',
    ]);
  });
});

describe('InferenceEvent', () => {
  const events = [
    { kind: 'stream-start', modelId: 'openai/gpt-5' },
    { kind: 'text-delta', index: 0, content: 'hel' },
    { kind: 'reasoning-delta', index: 0, content: 'thinking' },
    { kind: 'tool-call', id: 't1', name: 'search', args: { q: 'x' } },
    { kind: 'tool-result', id: 't1', name: 'search', result: { hits: [] } },
    { kind: 'step-start', step: 0 },
    { kind: 'step-finish', step: 0, generationId: 'gen-1' },
    { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
    {
      kind: 'media-done',
      index: 0,
      value: {
        ref: 'media/c/m/u',
        mimeType: 'image/png',
        modality: 'image',
        byteLength: 9,
        metadata: {},
      },
    },
    {
      kind: 'finish',
      metadata: { usage: { inputTokens: 1, outputTokens: 2 }, finishReason: 'stop' },
    },
  ];

  it.each(events.map((event) => [event.kind, event]))('parses the %s event', (_kind, event) => {
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('rejects an unknown event kind', () => {
    expect(InferenceEvent.safeParse({ kind: 'heartbeat' }).success).toBe(false);
  });

  it.each(TOOL_ERROR_REASONS.map((reason) => [reason]))(
    'parses a tool-error event with reason %s',
    (reason) => {
      const event = { kind: 'tool-error', id: 't1', name: 'webSearch', reason };
      expect(InferenceEvent.parse(event)).toEqual(event);
    }
  );

  it('closes the tool-error reasons to failed, limit and invalid-input', () => {
    expect(TOOL_ERROR_REASONS).toEqual(['failed', 'limit', 'invalid-input']);
  });

  it('rejects a tool-error event with a reason outside the closed set', () => {
    const event = { kind: 'tool-error', id: 't1', name: 'webSearch', reason: 'timeout' };
    expect(InferenceEvent.safeParse(event).success).toBe(false);
  });

  it('strips error text from a tool-error event', () => {
    const event = { kind: 'tool-error', id: 't1', name: 'webSearch', reason: 'failed', error: 'x' };
    expect(InferenceEvent.parse(event)).toEqual({
      kind: 'tool-error',
      id: 't1',
      name: 'webSearch',
      reason: 'failed',
    });
  });

  it('rejects a finish event without metadata', () => {
    expect(InferenceEvent.safeParse({ kind: 'finish' }).success).toBe(false);
  });

  it('parses a finish event carrying the level the call reasoned at', () => {
    const event = {
      kind: 'finish',
      metadata: { usage: { inputTokens: 1, outputTokens: 2 }, finishReason: 'stop' },
      reasoningEffort: 'high',
    };
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('keeps a finish event recording off distinct from one recording no level', () => {
    const base = { usage: { inputTokens: 1, outputTokens: 2 }, finishReason: 'stop' };
    const recordedOff = InferenceEvent.parse({
      kind: 'finish',
      metadata: base,
      reasoningEffort: 'off',
    });
    const recordedNone = InferenceEvent.parse({ kind: 'finish', metadata: base });
    expect(recordedOff).toHaveProperty('reasoningEffort', 'off');
    expect(recordedNone).not.toHaveProperty('reasoningEffort');
  });

  it('rejects a finish event whose recorded level is not a resolved rung', () => {
    const event = {
      kind: 'finish',
      metadata: { usage: { inputTokens: 1, outputTokens: 2 }, finishReason: 'stop' },
      reasoningEffort: 'auto',
    };
    expect(InferenceEvent.safeParse(event).success).toBe(false);
  });

  it('parses a step-finish carrying an optional per-step provider cost', () => {
    const event = { kind: 'step-finish', step: 0, generationId: 'gen-1', providerCostUsd: 0.001 };
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('parses a step-finish carrying the step’s usage', () => {
    const event = {
      kind: 'step-finish',
      step: 0,
      generationId: 'gen-1',
      usage: { inputTokens: 150_000, outputTokens: 500 },
    };
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('parses a step-finish naming the endpoint that served the step', () => {
    const event = {
      kind: 'step-finish',
      step: 0,
      generationId: 'gen-1',
      servedBy: 'Amazon Bedrock',
    };
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('rejects a step-finish naming an empty endpoint', () => {
    const event = { kind: 'step-finish', step: 0, generationId: 'gen-1', servedBy: '' };
    expect(InferenceEvent.safeParse(event).success).toBe(false);
  });

  it('rejects a stream-start with an empty modelId (every stream must be labeled)', () => {
    expect(InferenceEvent.safeParse({ kind: 'stream-start', modelId: '' }).success).toBe(false);
  });

  it('rejects a stream-start without a modelId', () => {
    expect(InferenceEvent.safeParse({ kind: 'stream-start' }).success).toBe(false);
  });

  it('parses a stream-start carrying the media output modality (early tile signal)', () => {
    const event = { kind: 'stream-start', modelId: 'sora/video-1', outputModality: 'video' };
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('parses a stream-start carrying the id its answer is stored under', () => {
    const event = { kind: 'stream-start', modelId: 'openai/gpt-5', messageId: 'message-1' };
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('rejects a stream-start with an empty message id', () => {
    expect(
      InferenceEvent.safeParse({ kind: 'stream-start', modelId: 'm', messageId: '' }).success
    ).toBe(false);
  });

  it('rejects a stream-start with an unknown outputModality', () => {
    expect(
      InferenceEvent.safeParse({ kind: 'stream-start', modelId: 'm', outputModality: 'hologram' })
        .success
    ).toBe(false);
  });

  it('parses a media-progress event', () => {
    const event = { kind: 'media-progress', index: 0, percent: 40 };
    expect(InferenceEvent.parse(event)).toEqual(event);
  });

  it('rejects a media-progress percent above 100', () => {
    expect(
      InferenceEvent.safeParse({ kind: 'media-progress', index: 0, percent: 101 }).success
    ).toBe(false);
  });

  it('rejects a negative media-progress percent', () => {
    expect(
      InferenceEvent.safeParse({ kind: 'media-progress', index: 0, percent: -1 }).success
    ).toBe(false);
  });

  it('rejects a media-progress without an index', () => {
    expect(InferenceEvent.safeParse({ kind: 'media-progress', percent: 10 }).success).toBe(false);
  });
});

describe('FilePart multi-output mapping', () => {
  it('parses an SDK file part', () => {
    const part = { mediaType: 'image/png', data: new Uint8Array([1, 2]) };
    expect(FilePart.parse(part)).toEqual(part);
  });

  it('a mapper produces the media-start/media-done event pair (type-level contract)', () => {
    const mapper: FilePartMapper = (part, index) => [
      { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
      {
        kind: 'media-done',
        index,
        value: {
          ref: 'media/c/m/u',
          mimeType: part.mediaType,
          modality: 'image',
          byteLength: part.data.byteLength,
          metadata: {},
        },
      },
    ];
    const [start, done] = mapper({ mediaType: 'image/png', data: new Uint8Array([1]) }, 0);
    expect(start.kind).toBe('media-start');
    expect(done.kind).toBe('media-done');
  });
});
