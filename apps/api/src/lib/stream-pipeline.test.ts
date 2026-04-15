import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    getModelPricing: vi.fn(actual.getModelPricing),
  };
});

vi.mock('./broadcast.js', () => ({
  broadcastFireAndForget: vi.fn(),
}));

vi.mock('@hushbox/realtime/events', () => ({
  createEvent: vi.fn((type: string, payload: unknown) => ({ type, payload })),
}));

import { getModelPricing } from '@hushbox/shared';
import { broadcastFireAndForget } from './broadcast.js';
import { createEvent } from '@hushbox/realtime/events';
import type { OpenRouterModel as ModelInfo } from '@hushbox/shared/models';
import type { InferenceEvent, InferenceStream } from '../services/ai/index.js';
import {
  BATCH_INTERVAL_MS,
  lookupModelPricing,
  computeWorstCaseCents,
  resolveWebSearchCost,
  handleBillingResult,
  withBroadcast,
  broadcastAndFinish,
  type BroadcastContext,
} from './stream-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Stub envelope/content-item used by billingResult fixtures. Uses the fishery
// factories would complicate the pure unit test setup, so inline a minimal
// shape matching the InsertedTextContentItem type.
const stubUserEnvelope = {
  messageId: 'user-msg-stub',
  wrappedContentKey: new Uint8Array([0, 1, 2, 3]),
  contentItem: {
    id: 'ci-stub',
    contentType: 'text' as const,
    position: 0,
    encryptedBlob: new Uint8Array([9, 9, 9]),
    modelName: null,
    cost: null,
    isSmartModel: false,
  },
};

function makeModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    description: 'A model',
    context_length: 128_000,
    pricing: { prompt: '0.000005', completion: '0.000015' },
    supported_parameters: [],
    created: Date.now(),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    ...overrides,
  };
}

function createMockContext(): {
  c: Parameters<typeof handleBillingResult>[0]['c'];
} {
  return {
    c: {
      executionCtx: {
        waitUntil: vi.fn(),
      },
    } as unknown as Parameters<typeof handleBillingResult>[0]['c'],
  };
}

// ---------------------------------------------------------------------------
// BATCH_INTERVAL_MS
// ---------------------------------------------------------------------------

describe('BATCH_INTERVAL_MS', () => {
  it('equals 100', () => {
    expect(BATCH_INTERVAL_MS).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// lookupModelPricing
// ---------------------------------------------------------------------------

describe('lookupModelPricing', () => {
  beforeEach(() => {
    vi.mocked(getModelPricing).mockClear();
  });

  it('finds a model by id and delegates to getModelPricing', () => {
    const models = [makeModelInfo({ id: 'openai/gpt-4o' })];

    const result = lookupModelPricing(models, 'openai/gpt-4o');

    expect(getModelPricing).toHaveBeenCalledWith(0.000_005, 0.000_015, 128_000);
    expect(result).toHaveProperty('inputPricePerToken');
    expect(result).toHaveProperty('outputPricePerToken');
    expect(result).toHaveProperty('contextLength', 128_000);
  });

  it('passes 0 for pricing when model is not found', () => {
    const models = [makeModelInfo({ id: 'openai/gpt-4o' })];

    lookupModelPricing(models, 'nonexistent/model');

    expect(getModelPricing).toHaveBeenCalledWith(0, 0, 128_000);
  });

  it('uses model context_length when found', () => {
    const models = [makeModelInfo({ id: 'anthropic/claude', context_length: 200_000 })];

    const result = lookupModelPricing(models, 'anthropic/claude');

    expect(result.contextLength).toBe(200_000);
  });

  it('falls back to 128_000 context length when model is not found', () => {
    lookupModelPricing([], 'missing/model');

    expect(getModelPricing).toHaveBeenCalledWith(0, 0, 128_000);
  });

  it('correctly parses string pricing to numbers', () => {
    const models = [
      makeModelInfo({
        id: 'test/model',
        pricing: { prompt: '0.00001', completion: '0.00003' },
      }),
    ];

    lookupModelPricing(models, 'test/model');

    expect(getModelPricing).toHaveBeenCalledWith(0.000_01, 0.000_03, 128_000);
  });

  it('selects the correct model from multiple entries', () => {
    const models = [
      makeModelInfo({ id: 'model/a', pricing: { prompt: '0.001', completion: '0.002' } }),
      makeModelInfo({ id: 'model/b', pricing: { prompt: '0.003', completion: '0.004' } }),
    ];

    lookupModelPricing(models, 'model/b');

    expect(getModelPricing).toHaveBeenCalledWith(0.003, 0.004, 128_000);
  });
});

// ---------------------------------------------------------------------------
// computeWorstCaseCents
// ---------------------------------------------------------------------------

describe('computeWorstCaseCents', () => {
  it('computes (estimatedInputCost + maxOutput * outputCost) * 100', () => {
    // (0.50 + 1000 * 0.001) * 100 = (0.50 + 1.0) * 100 = 150
    const result = computeWorstCaseCents(0.5, 1000, 0.001);
    expect(result).toBe(150);
  });

  it('returns 0 when all inputs are 0', () => {
    expect(computeWorstCaseCents(0, 0, 0)).toBe(0);
  });

  it('handles fractional cents without rounding', () => {
    // (0.001 + 10 * 0.0001) * 100 = (0.001 + 0.001) * 100 = 0.2
    const result = computeWorstCaseCents(0.001, 10, 0.0001);
    expect(result).toBeCloseTo(0.2, 10);
  });

  it('handles large token counts', () => {
    // (1.0 + 1_000_000 * 0.00001) * 100 = (1.0 + 10) * 100 = 1100
    const result = computeWorstCaseCents(1, 1_000_000, 0.000_01);
    expect(result).toBeCloseTo(1100, 5);
  });

  it('handles zero output tokens', () => {
    // (0.25 + 0 * 0.001) * 100 = 25
    const result = computeWorstCaseCents(0.25, 0, 0.001);
    expect(result).toBe(25);
  });

  it('handles zero input cost', () => {
    // (0 + 500 * 0.002) * 100 = 100
    const result = computeWorstCaseCents(0, 500, 0.002);
    expect(result).toBe(100);
  });
});

// buildOpenRouterRequest tests removed — function deleted in Step 3 (AIClient migration)

// ---------------------------------------------------------------------------
// resolveWebSearchCost
// ---------------------------------------------------------------------------

describe('resolveWebSearchCost', () => {
  it('returns 0 when webSearchEnabled is false', () => {
    const models = [
      makeModelInfo({
        id: 'openai/gpt-4o',
        pricing: { prompt: '0.000005', completion: '0.000015', web_search: '0.004' },
      }),
    ];

    expect(resolveWebSearchCost(false, 'openai/gpt-4o', models)).toBe(0);
  });

  it('returns parsed web_search cost when enabled and model has web_search pricing', () => {
    const models = [
      makeModelInfo({
        id: 'openai/gpt-4o',
        pricing: { prompt: '0.000005', completion: '0.000015', web_search: '0.004' },
      }),
    ];

    expect(resolveWebSearchCost(true, 'openai/gpt-4o', models)).toBe(0.004);
  });

  it('returns 0 when enabled but model has no web_search pricing', () => {
    const models = [
      makeModelInfo({
        id: 'openai/gpt-4o',
        pricing: { prompt: '0.000005', completion: '0.000015' },
      }),
    ];

    expect(resolveWebSearchCost(true, 'openai/gpt-4o', models)).toBe(0);
  });

  it('returns 0 when enabled but model is not found', () => {
    const models = [makeModelInfo({ id: 'openai/gpt-4o' })];

    expect(resolveWebSearchCost(true, 'nonexistent/model', models)).toBe(0);
  });

  it('returns 0 when models array is empty', () => {
    expect(resolveWebSearchCost(true, 'openai/gpt-4o', [])).toBe(0);
  });

  it('parses web_search string pricing correctly', () => {
    const models = [
      makeModelInfo({
        id: 'test/model',
        pricing: { prompt: '0', completion: '0', web_search: '0.0123' },
      }),
    ];

    expect(resolveWebSearchCost(true, 'test/model', models)).toBe(0.0123);
  });
});

// ---------------------------------------------------------------------------
// handleBillingResult
// ---------------------------------------------------------------------------

describe('handleBillingResult', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns billing result on success', async () => {
    const { c } = createMockContext();
    const billingResult = {
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.0042',
      usageRecordId: 'usage-123',
      userEnvelope: stubUserEnvelope,
      assistantResults: [],
    };

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.resolve(billingResult),
      assistantMessageId: 'asst-123',
      userId: 'user-1',
      senderId: 'user-1',
      model: 'openai/gpt-4o',
      generationId: 'gen-abc',
    });

    expect(result).toEqual(billingResult);
  });

  it('returns null and logs error when billing promise rejects', async () => {
    const { c } = createMockContext();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.reject(new Error('DB connection failed')),
      assistantMessageId: 'asst-456',
      userId: 'user-2',
      senderId: 'user-2',
      model: 'anthropic/claude',
      generationId: 'gen-xyz',
    });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledOnce();

    const loggedJson = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(loggedJson).toMatchObject({
      event: 'billing_failed',
      messageId: 'asst-456',
      userId: 'user-2',
      model: 'anthropic/claude',
      generationId: 'gen-xyz',
      error: 'DB connection failed',
    });
    expect(loggedJson.timestamp).toBeDefined();
  });

  it('logs stringified non-Error rejection values', async () => {
    const { c } = createMockContext();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.reject(new Error('string error')),
      assistantMessageId: 'asst-789',
      userId: 'user-3',
      senderId: 'user-3',
      model: 'model/x',
      generationId: undefined,
    });

    expect(result).toBeNull();
    const loggedJson = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(loggedJson.error).toBe('string error');
    expect(loggedJson.generationId).toBeUndefined();
  });

  it('calls waitUntil with the billing promise', async () => {
    const { c } = createMockContext();
    const billingPromise = Promise.resolve({
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.001',
      usageRecordId: 'u-1',
      userEnvelope: stubUserEnvelope,
      assistantResults: [],
    });

    await handleBillingResult({
      c,
      billingPromise,
      assistantMessageId: 'asst-1',
      userId: 'user-1',
      senderId: 'user-1',
      model: 'model/a',
      generationId: undefined,
    });

    expect(c.executionCtx.waitUntil).toHaveBeenCalledOnce();
  });

  it('handles missing executionCtx gracefully', async () => {
    const c = {} as Parameters<typeof handleBillingResult>[0]['c'];
    const billingResult = {
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.001',
      usageRecordId: 'u-1',
      userEnvelope: stubUserEnvelope,
      assistantResults: [],
    };

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.resolve(billingResult),
      assistantMessageId: 'asst-1',
      userId: 'user-1',
      senderId: 'user-1',
      model: 'model/a',
      generationId: undefined,
    });

    expect(result).toEqual(billingResult);
  });
});

// ---------------------------------------------------------------------------
// withBroadcast
// ---------------------------------------------------------------------------

describe('withBroadcast', () => {
  beforeEach(() => {
    vi.mocked(broadcastFireAndForget).mockClear();
    vi.mocked(createEvent).mockClear();
  });

  const broadcast: BroadcastContext = {
    env: {} as BroadcastContext['env'],
    conversationId: 'conv-1',
    assistantMessageId: 'asst-1',
    modelName: 'openai/gpt-4o',
  };

  async function collectAll(stream: InferenceStream): Promise<InferenceEvent[]> {
    const items: InferenceEvent[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    return items;
  }

  function textDeltaStream(tokens: string[]): InferenceStream {
    return {
      [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
        let index = 0;
        return {
          next(): Promise<IteratorResult<InferenceEvent>> {
            if (index >= tokens.length) return Promise.resolve({ done: true, value: undefined });
            const content = tokens[index++]!;
            return Promise.resolve({
              done: false,
              value: { kind: 'text-delta' as const, content },
            });
          },
        };
      },
    };
  }

  it('passes through all events unchanged', async () => {
    const stream = textDeltaStream(['Hello', ' World']);
    const wrapped = withBroadcast(stream, broadcast);

    const items = await collectAll(wrapped);

    expect(items).toEqual([
      { kind: 'text-delta', content: 'Hello' },
      { kind: 'text-delta', content: ' World' },
    ]);
  });

  it('flushes remaining buffer on stream completion', async () => {
    const stream = textDeltaStream(['token']);
    const wrapped = withBroadcast(stream, broadcast);

    await collectAll(wrapped);

    expect(broadcastFireAndForget).toHaveBeenCalled();
    const lastCallEvent = vi.mocked(createEvent).mock.calls.at(-1);
    expect(lastCallEvent).toBeDefined();
    expect(lastCallEvent![0]).toBe('message:stream');
    expect(lastCallEvent![1]).toMatchObject({
      messageId: 'asst-1',
      token: 'token',
      modelName: 'openai/gpt-4o',
    });
  });

  it('includes modelName in broadcast events when provided', async () => {
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcast);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload['modelName']).toBe('openai/gpt-4o');
  });

  it('omits modelName from broadcast events when undefined', async () => {
    const broadcastNoModel: BroadcastContext = {
      env: {} as BroadcastContext['env'],
      conversationId: 'conv-1',
      assistantMessageId: 'asst-1',
    };
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcastNoModel);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('modelName');
  });

  it('includes senderId in broadcast events when provided', async () => {
    const broadcastWithSender: BroadcastContext = {
      env: {} as BroadcastContext['env'],
      conversationId: 'conv-1',
      assistantMessageId: 'asst-1',
      modelName: 'openai/gpt-4o',
      senderId: 'user-42',
    };
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcastWithSender);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload['senderId']).toBe('user-42');
  });

  it('omits senderId from broadcast events when undefined', async () => {
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcast);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('senderId');
  });

  it('handles empty stream without error', async () => {
    const emptyStream: InferenceStream = {
      [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
        return {
          next(): Promise<IteratorResult<InferenceEvent>> {
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    const wrapped = withBroadcast(emptyStream, broadcast);
    const items = await collectAll(wrapped);

    expect(items).toEqual([]);
    expect(broadcastFireAndForget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// broadcastAndFinish
// ---------------------------------------------------------------------------

describe('broadcastAndFinish', () => {
  const stubTextContentItem = (overrides: {
    id: string;
    encryptedBlob: Uint8Array;
    modelName?: string | null;
    cost?: string | null;
  }) => ({
    id: overrides.id,
    contentType: 'text' as const,
    position: 0,
    encryptedBlob: overrides.encryptedBlob,
    storageKey: null,
    mimeType: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    modelName: overrides.modelName ?? null,
    cost: overrides.cost ?? null,
    isSmartModel: false,
    createdAt: new Date(),
  });

  beforeEach(() => {
    vi.mocked(broadcastFireAndForget).mockClear();
    vi.mocked(createEvent).mockClear();
  });

  it('broadcasts message:complete and writes done event', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const writeDone = vi.fn().mockResolvedValue(undefined);
    const writer = { writeDone } as unknown as ReturnType<
      typeof import('./stream-handler.js').createSSEEventWriter
    >;

    const c = {
      env: {} as BroadcastContext['env'],
      executionCtx: { waitUntil: vi.fn() },
    } as unknown as Parameters<typeof broadcastAndFinish>[0]['c'];

    await broadcastAndFinish({
      c,
      conversationId: 'conv-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      billingResult: {
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 3,
        cost: '0.005',
        usageRecordId: 'u-1',
        userEnvelope: {
          messageId: 'user-1',
          wrappedContentKey: new Uint8Array([1, 2, 3]),
          contentItem: stubTextContentItem({
            id: 'ci-user',
            encryptedBlob: new Uint8Array([9, 9, 9]),
          }),
        },
        assistantResults: [],
      },
      writer,
      modelName: 'openai/gpt-4o',
    });

    expect(createEvent).toHaveBeenCalledWith('message:complete', {
      messageId: 'asst-1',
      conversationId: 'conv-1',
      sequenceNumber: 2,
      epochNumber: 3,
      modelName: 'openai/gpt-4o',
    });
    expect(broadcastFireAndForget).toHaveBeenCalledOnce();

    expect(writeDone).toHaveBeenCalledOnce();
  });

  it('omits modelName from broadcast when undefined', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const writeDone = vi.fn().mockResolvedValue(undefined);
    const writer = { writeDone } as unknown as ReturnType<
      typeof import('./stream-handler.js').createSSEEventWriter
    >;

    const c = {
      env: {} as BroadcastContext['env'],
      executionCtx: { waitUntil: vi.fn() },
    } as unknown as Parameters<typeof broadcastAndFinish>[0]['c'];

    await broadcastAndFinish({
      c,
      conversationId: 'conv-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      billingResult: {
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 3,
        cost: '0.005',
        usageRecordId: 'u-1',
        userEnvelope: {
          messageId: 'user-1',
          wrappedContentKey: new Uint8Array([1, 2, 3]),
          contentItem: stubTextContentItem({
            id: 'ci-user',
            encryptedBlob: new Uint8Array([9, 9, 9]),
          }),
        },
        assistantResults: [],
      },
      writer,
    });

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('modelName');
  });

  it('forwards user and per-model envelope data to writeDone', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const writeDone = vi.fn().mockResolvedValue(undefined);
    const writer = { writeDone } as unknown as ReturnType<
      typeof import('./stream-handler.js').createSSEEventWriter
    >;

    const c = {
      env: {} as BroadcastContext['env'],
      executionCtx: { waitUntil: vi.fn() },
    } as unknown as Parameters<typeof broadcastAndFinish>[0]['c'];

    const userWrapped = new Uint8Array([1, 1, 1]);
    const aiWrapped = new Uint8Array([2, 2, 2]);
    const userBlob = new Uint8Array([3, 3, 3]);
    const aiBlob = new Uint8Array([4, 4, 4]);

    await broadcastAndFinish({
      c,
      conversationId: 'conv-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      billingResult: {
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 3,
        cost: '0.005',
        usageRecordId: 'u-1',
        userEnvelope: {
          messageId: 'user-1',
          wrappedContentKey: userWrapped,
          contentItem: stubTextContentItem({ id: 'ci-user', encryptedBlob: userBlob }),
        },
        assistantResults: [
          {
            assistantMessageId: 'asst-1',
            model: 'openai/gpt-4o',
            aiSequence: 2,
            cost: '0.005',
            usageRecordId: 'u-1',
            envelope: {
              messageId: 'asst-1',
              wrappedContentKey: aiWrapped,
              contentItem: stubTextContentItem({
                id: 'ci-ai',
                encryptedBlob: aiBlob,
                modelName: 'openai/gpt-4o',
                cost: '0.005',
              }),
            },
          },
        ],
      },
      writer,
      modelName: 'openai/gpt-4o',
    });

    expect(writeDone).toHaveBeenCalledOnce();
    const args = writeDone.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['userMessageId']).toBe('user-1');
    expect(args['assistantMessageId']).toBe('asst-1');
    expect(args['userSequence']).toBe(1);
    expect(args['aiSequence']).toBe(2);
    expect(args['epochNumber']).toBe(3);
    expect(args['cost']).toBe('0.005');

    const userEnvelope = args['userEnvelope'] as
      | { wrappedContentKey: string; contentItems: Record<string, unknown>[] }
      | undefined;
    expect(userEnvelope).toBeDefined();
    expect(userEnvelope!.wrappedContentKey).toBe(Buffer.from(userWrapped).toString('base64'));
    expect(userEnvelope!.contentItems).toHaveLength(1);
    expect(userEnvelope!.contentItems[0]!['id']).toBe('ci-user');
    expect(userEnvelope!.contentItems[0]!['encryptedBlob']).toBe(
      Buffer.from(userBlob).toString('base64')
    );

    const models = args['models'] as Record<string, unknown>[];
    expect(models).toHaveLength(1);
    const first = models[0]!;
    expect(first['modelId']).toBe('openai/gpt-4o');
    expect(first['assistantMessageId']).toBe('asst-1');
    expect(first['aiSequence']).toBe(2);
    expect(first['cost']).toBe('0.005');
    expect(first['wrappedContentKey']).toBe(Buffer.from(aiWrapped).toString('base64'));
    const items = first['contentItems'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]!['id']).toBe('ci-ai');
    expect(items[0]!['encryptedBlob']).toBe(Buffer.from(aiBlob).toString('base64'));
    expect(items[0]!['modelName']).toBe('openai/gpt-4o');
  });
});
