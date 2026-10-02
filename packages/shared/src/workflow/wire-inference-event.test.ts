import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FINISH_REASONS } from './inference.ts';
import { toWireInferenceEvent, WireInferenceEvent } from './wire-inference-event.ts';
import type { InferenceEvent } from './inference.ts';

type CostFreeKind = Exclude<InferenceEvent['kind'], 'step-finish' | 'finish'>;

// Keyed by every kind that carries no cost, so a kind added to the event
// union fails to compile here until it is shown to cross the wire unchanged.
const costFreeEvents: Record<CostFreeKind, InferenceEvent> = {
  'stream-start': { kind: 'stream-start', modelId: 'openai/gpt-5', outputModality: 'image' },
  'text-delta': { kind: 'text-delta', index: 0, content: 'hel' },
  'reasoning-delta': { kind: 'reasoning-delta', index: 0, content: 'thinking' },
  'tool-call': { kind: 'tool-call', id: 't1', name: 'webSearch', args: { q: 'x' } },
  'tool-result': { kind: 'tool-result', id: 't1', name: 'webSearch', result: { hits: [] } },
  'tool-error': { kind: 'tool-error', id: 't1', name: 'webSearch', reason: 'failed' },
  'step-start': { kind: 'step-start', step: 0 },
  'media-start': { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
  'media-done': {
    kind: 'media-done',
    index: 0,
    value: {
      ref: 'media/c/m/u',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 9,
      metadata: { width: 4 },
    },
  },
  'media-progress': { kind: 'media-progress', index: 0, percent: 40 },
};

const finish: InferenceEvent = {
  kind: 'finish',
  metadata: {
    generationId: 'gen-1',
    usage: { inputTokens: 120, outputTokens: 80, reasoningTokens: 30, cachedInputTokens: 10 },
    finishReason: 'stop',
    providerCostUsd: 0.0042,
    raw: { usage: { prompt_tokens: 120, completion_tokens: 80 }, cost: 0.0042 },
    servedBy: 'Amazon Bedrock',
  },
  reasoningEffort: 'high',
};

const stepFinish: InferenceEvent = {
  kind: 'step-finish',
  step: 1,
  generationId: 'gen-2',
  providerCostUsd: 0.001,
  usage: { inputTokens: 190_000, outputTokens: 500 },
  servedBy: 'Google Vertex',
};

// Keyed by every kind, so a kind added to the event union fails to compile
// here until its projection is shown to parse on the wire.
const everyEvent: Record<InferenceEvent['kind'], InferenceEvent> = {
  ...costFreeEvents,
  'step-finish': stepFinish,
  finish,
};

describe('toWireInferenceEvent', () => {
  it.each(Object.entries(everyEvent))(
    'projects the %s event to a copy the wire schema accepts unchanged',
    (_kind, event) => {
      const wire = toWireInferenceEvent(event);
      expect(WireInferenceEvent.parse(wire)).toStrictEqual(wire);
    }
  );

  it.each(Object.entries(everyEvent))(
    'projects the %s event to a copy with no raw provider response',
    (_kind, event) => {
      expect(toWireInferenceEvent(event)).not.toHaveProperty('metadata.raw');
    }
  );

  it.each(Object.entries(costFreeEvents))('carries the %s event unchanged', (_kind, event) => {
    expect(toWireInferenceEvent(event)).toStrictEqual(event);
  });

  it('returns a copy rather than the event it was given', () => {
    const event = costFreeEvents['text-delta'];
    expect(toWireInferenceEvent(event)).not.toBe(event);
  });

  it('drops the provider cost, the usage and the serving endpoint from a step-finish', () => {
    expect(toWireInferenceEvent(stepFinish)).toStrictEqual({
      kind: 'step-finish',
      step: 1,
      generationId: 'gen-2',
    });
  });

  it('keeps every finish field but the cost, the raw response, the serving endpoint and the non-reasoning counts', () => {
    expect(toWireInferenceEvent(finish)).toStrictEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen-1',
        usage: { reasoningTokens: 30 },
        finishReason: 'stop',
      },
      reasoningEffort: 'high',
    });
  });

  it('carries an empty usage when the finish reports no reasoning count', () => {
    const plain: InferenceEvent = {
      kind: 'finish',
      metadata: { usage: { inputTokens: 1, outputTokens: 2 }, finishReason: 'length' },
    };
    expect(toWireInferenceEvent(plain)).toStrictEqual({
      kind: 'finish',
      metadata: { usage: {}, finishReason: 'length' },
    });
  });

  it('leaves the event it projects untouched', () => {
    const original = structuredClone(finish);
    toWireInferenceEvent(finish);
    expect(finish).toStrictEqual(original);
  });
});

describe('WireInferenceEvent', () => {
  it.each(Object.entries(costFreeEvents))('carries the %s event unchanged', (_kind, event) => {
    expect(WireInferenceEvent.parse(event)).toEqual(event);
  });

  it('drops the raw provider response when it parses a full finish', () => {
    expect(WireInferenceEvent.parse(finish)).not.toHaveProperty('metadata.raw');
  });

  it('drops the serving endpoint when it parses a full finish', () => {
    expect(WireInferenceEvent.parse(finish)).not.toHaveProperty('metadata.servedBy');
  });

  it('drops the usage and the serving endpoint when it parses a full step-finish', () => {
    const parsed = WireInferenceEvent.parse(stepFinish);
    expect(parsed).not.toHaveProperty('usage');
    expect(parsed).not.toHaveProperty('servedBy');
  });

  it('rejects a finish without a usage object', () => {
    expect(
      WireInferenceEvent.safeParse({ kind: 'finish', metadata: { finishReason: 'stop' } }).success
    ).toBe(false);
  });

  it('rejects an unknown event kind', () => {
    expect(WireInferenceEvent.safeParse({ kind: 'heartbeat' }).success).toBe(false);
  });
});

describe('toWireInferenceEvent over generated finishes', () => {
  // Generator `providerFinishes`: finish events with arbitrary token counts,
  // optional cost, generation id, reasoning count, effort and raw response.
  const providerFinishes = fc.record(
    {
      generationId: fc.string({ minLength: 1, maxLength: 8 }),
      inputTokens: fc.nat(),
      outputTokens: fc.nat(),
      reasoningTokens: fc.nat(),
      cachedInputTokens: fc.nat(),
      providerCostUsd: fc.double({ min: 0, max: 10, noNaN: true }),
      finishReason: fc.constantFrom(...FINISH_REASONS),
      reasoningEffort: fc.constantFrom('off', 'low', 'high'),
      raw: fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue({ maxDepth: 2 })),
    },
    { requiredKeys: ['inputTokens', 'outputTokens', 'finishReason'] }
  );

  it('projects any finish to its fields less cost, raw response and every count but reasoning', () => {
    fc.assert(
      fc.property(providerFinishes, (drawn) => {
        const { generationId, reasoningTokens, cachedInputTokens, providerCostUsd } = drawn;
        const event: InferenceEvent = {
          kind: 'finish',
          metadata: {
            ...(generationId === undefined ? {} : { generationId }),
            usage: {
              inputTokens: drawn.inputTokens,
              outputTokens: drawn.outputTokens,
              ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
              ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            },
            finishReason: drawn.finishReason,
            ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
            ...(drawn.raw === undefined ? {} : { raw: drawn.raw }),
          },
          ...(drawn.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: drawn.reasoningEffort }),
        };
        const original = structuredClone(event);
        const wire = toWireInferenceEvent(event);
        // Not strict: the generated raw record has a null prototype, and a clone does not.
        expect(event).toEqual(original);
        expect(wire).toStrictEqual({
          kind: 'finish',
          metadata: {
            ...(generationId === undefined ? {} : { generationId }),
            usage: reasoningTokens === undefined ? {} : { reasoningTokens },
            finishReason: drawn.finishReason,
          },
          ...(drawn.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: drawn.reasoningEffort }),
        });
      })
    );
  });
});
