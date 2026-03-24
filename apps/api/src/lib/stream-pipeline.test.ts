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
import type { ModelInfo } from '../services/openrouter/types.js';
import type { ChatMessage } from '../services/openrouter/types.js';
import {
  BATCH_INTERVAL_MS,
  lookupModelPricing,
  computeWorstCaseCents,
  buildOpenRouterRequest,
  resolveWebSearchCost,
  handleBillingResult,
  withBroadcast,
  broadcastAndFinish,
  type BroadcastContext,
} from './stream-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildOpenRouterRequest
// ---------------------------------------------------------------------------

describe('buildOpenRouterRequest', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ];

  it('builds a basic request with model and messages', () => {
    const result = buildOpenRouterRequest({
      model: 'openai/gpt-4o',
      messages,
      safeMaxTokens: undefined,
      webSearchEnabled: false,
    });

    expect(result).toEqual({
      model: 'openai/gpt-4o',
      messages,
    });
  });

  it('includes max_tokens when safeMaxTokens is provided', () => {
    const result = buildOpenRouterRequest({
      model: 'openai/gpt-4o',
      messages,
      safeMaxTokens: 4096,
      webSearchEnabled: false,
    });

    expect(result).toEqual({
      model: 'openai/gpt-4o',
      messages,
      max_tokens: 4096,
    });
  });

  it('omits max_tokens when safeMaxTokens is undefined', () => {
    const result = buildOpenRouterRequest({
      model: 'openai/gpt-4o',
      messages,
      safeMaxTokens: undefined,
      webSearchEnabled: false,
    });

    expect(result).not.toHaveProperty('max_tokens');
  });

  it('includes web plugin when webSearchEnabled is true', () => {
    const result = buildOpenRouterRequest({
      model: 'openai/gpt-4o',
      messages,
      safeMaxTokens: undefined,
      webSearchEnabled: true,
    });

    expect(result.plugins).toEqual([{ id: 'web' }]);
  });

  it('omits plugins when webSearchEnabled is false and no autoRouterAllowedModels', () => {
    const result = buildOpenRouterRequest({
      model: 'openai/gpt-4o',
      messages,
      safeMaxTokens: undefined,
      webSearchEnabled: false,
    });

    expect(result).not.toHaveProperty('plugins');
  });

  it('includes auto-router plugin with allowed_models when autoRouterAllowedModels is provided', () => {
    const allowed = ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'];
    const result = buildOpenRouterRequest({
      model: 'openrouter/auto',
      messages,
      safeMaxTokens: undefined,
      webSearchEnabled: false,
      autoRouterAllowedModels: allowed,
    });

    expect(result.plugins).toEqual([{ id: 'auto-router', allowed_models: allowed }]);
  });

  it('includes both auto-router and web plugins when both are enabled', () => {
    const allowed = ['openai/gpt-4o'];
    const result = buildOpenRouterRequest({
      model: 'openrouter/auto',
      messages,
      safeMaxTokens: 2048,
      webSearchEnabled: true,
      autoRouterAllowedModels: allowed,
    });

    expect(result.plugins).toEqual([{ id: 'auto-router', allowed_models: allowed }, { id: 'web' }]);
    expect(result.max_tokens).toBe(2048);
  });

  it('preserves plugin order: auto-router before web', () => {
    const allowed = ['model/a'];
    const result = buildOpenRouterRequest({
      model: 'model',
      messages,
      safeMaxTokens: undefined,
      webSearchEnabled: true,
      autoRouterAllowedModels: allowed,
    });

    expect(result.plugins![0]!.id).toBe('auto-router');
    expect(result.plugins![1]!.id).toBe('web');
  });

  it('handles empty autoRouterAllowedModels array', () => {
    const result = buildOpenRouterRequest({
      model: 'model',
      messages,
      safeMaxTokens: undefined,
      webSearchEnabled: false,
      autoRouterAllowedModels: [],
    });

    expect(result.plugins).toEqual([{ id: 'auto-router', allowed_models: [] }]);
  });
});

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
      assistantResults: [],
    };

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.resolve(billingResult),
      assistantMessageId: 'asst-123',
      userId: 'user-1',
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
      assistantResults: [],
    });

    await handleBillingResult({
      c,
      billingPromise,
      assistantMessageId: 'asst-1',
      userId: 'user-1',
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
      assistantResults: [],
    };

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.resolve(billingResult),
      assistantMessageId: 'asst-1',
      userId: 'user-1',
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

  async function collectAll(
    iterable: AsyncIterable<{ content: string; generationId?: string }>
  ): Promise<{ content: string; generationId?: string }[]> {
    const items: { content: string; generationId?: string }[] = [];
    for await (const item of iterable) {
      items.push(item);
    }
    return items;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function* tokenStream(
    tokens: string[]
  ): AsyncIterable<{ content: string; generationId?: string }> {
    for (const t of tokens) {
      yield { content: t };
    }
  }

  it('passes through all tokens unchanged', async () => {
    const stream = tokenStream(['Hello', ' World']);
    const wrapped = withBroadcast(stream, broadcast);

    const items = await collectAll(wrapped);

    expect(items).toEqual([{ content: 'Hello' }, { content: ' World' }]);
  });

  it('flushes remaining buffer on stream completion', async () => {
    // Use a single token that won't trigger interval-based flush
    const stream = tokenStream(['token']);
    const wrapped = withBroadcast(stream, broadcast);

    await collectAll(wrapped);

    // The flush happens on done — broadcastFireAndForget should have been called at least once
    expect(broadcastFireAndForget).toHaveBeenCalled();
    // Last call should include the token content
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
    const stream = tokenStream(['hi']);
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
    const stream = tokenStream(['hi']);
    const wrapped = withBroadcast(stream, broadcastNoModel);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('modelName');
  });

  it('handles empty stream without error', async () => {
    async function* empty(): AsyncIterable<{ content: string; generationId?: string }> {
      // yields nothing
    }

    const wrapped = withBroadcast(empty(), broadcast);
    const items = await collectAll(wrapped);

    expect(items).toEqual([]);
    // No tokens to broadcast — should not call broadcastFireAndForget for streaming
    // (the done handler only broadcasts if tokenBuffer is non-empty)
    expect(broadcastFireAndForget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// broadcastAndFinish
// ---------------------------------------------------------------------------

describe('broadcastAndFinish', () => {
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

    expect(writeDone).toHaveBeenCalledWith({
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 3,
      cost: '0.005',
    });
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
        assistantResults: [],
      },
      writer,
    });

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('modelName');
  });
});
