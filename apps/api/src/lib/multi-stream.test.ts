import { describe, it, expect } from 'vitest';
import { collectMultiModelStreams, type ModelStreamEntry } from './multi-stream.js';
import type { SSEEventWriter } from './stream-handler.js';

function createMockWriter(): SSEEventWriter & {
  events: { method: string; args: unknown[] }[];
} {
  const events: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    // eslint-disable-next-line @typescript-eslint/require-await
    async (...args: unknown[]): Promise<void> => {
      events.push({ method, args });
    };

  return {
    events,
    writeStart: record('writeStart'),
    writeToken: record('writeToken'),
    writeModelToken: record('writeModelToken'),
    writeError: record('writeError'),
    writeModelDone: record('writeModelDone'),
    writeModelError: record('writeModelError'),
    writeDone: record('writeDone'),
    isConnected: () => true,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* createTokenStream(
  tokens: string[],
  generationId?: string,
  inlineCost?: number
): AsyncIterable<{ content: string; generationId?: string; inlineCost?: number }> {
  for (const [index, token] of tokens.entries()) {
    yield {
      content: token,
      ...(index === 0 && generationId !== undefined ? { generationId } : {}),
    };
  }
  // Yield inline cost as final token (mirrors real OpenRouter behavior)
  if (inlineCost !== undefined) {
    yield { content: '', inlineCost };
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* createFailingStream(
  tokensBeforeError: string[],
  error: Error
): AsyncIterable<{ content: string; generationId?: string; inlineCost?: number }> {
  for (const token of tokensBeforeError) {
    yield { content: token };
  }
  throw error;
}

describe('collectMultiModelStreams', () => {
  it('collects tokens from a single model', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: createTokenStream(['Hello', ' world'], 'gen-1', 0.001),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);

    expect(results.size).toBe(1);
    const result = results.get('openai/gpt-4o')!;
    expect(result.fullContent).toBe('Hello world');
    expect(result.generationId).toBe('gen-1');
    expect(result.inlineCost).toBe(0.001);
    expect(result.error).toBeNull();
  });

  it('collects tokens from multiple models in parallel', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: createTokenStream(['A1', 'A2'], 'gen-a', 0.002),
      },
      {
        modelId: 'anthropic/claude-3.5-sonnet',
        assistantMessageId: 'asst-2',
        stream: createTokenStream(['B1', 'B2'], 'gen-b', 0.003),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);

    expect(results.size).toBe(2);
    expect(results.get('openai/gpt-4o')!.fullContent).toBe('A1A2');
    expect(results.get('openai/gpt-4o')!.inlineCost).toBe(0.002);
    expect(results.get('anthropic/claude-3.5-sonnet')!.fullContent).toBe('B1B2');
    expect(results.get('anthropic/claude-3.5-sonnet')!.inlineCost).toBe(0.003);
  });

  it('writes model-tagged tokens to SSE writer', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: createTokenStream(['Hi']),
      },
    ];

    await collectMultiModelStreams(entries, writer);

    const tokenEvents = writer.events.filter((e) => e.method === 'writeModelToken');
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]!.args[0]).toEqual({ modelId: 'openai/gpt-4o', content: 'Hi' });
  });

  it('does not write empty content tokens to SSE writer', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: createTokenStream(['Hi'], undefined, 0.001),
      },
    ];

    await collectMultiModelStreams(entries, writer);

    // Only the content token should be written, not the empty inline cost token
    const tokenEvents = writer.events.filter((e) => e.method === 'writeModelToken');
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]!.args[0]).toEqual({ modelId: 'openai/gpt-4o', content: 'Hi' });
  });

  it('writes model:done for each completed model', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: createTokenStream(['Done']),
      },
      {
        modelId: 'anthropic/claude-3.5-sonnet',
        assistantMessageId: 'asst-2',
        stream: createTokenStream(['Also done']),
      },
    ];

    await collectMultiModelStreams(entries, writer);

    const doneEvents = writer.events.filter((e) => e.method === 'writeModelDone');
    expect(doneEvents).toHaveLength(2);
    const modelIds = doneEvents.map((e) => (e.args[0] as { modelId: string }).modelId);
    expect(modelIds.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
    ]);
  });

  it('handles partial failure — captures error per model', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: createTokenStream(['Good response'], undefined, 0.001),
      },
      {
        modelId: 'anthropic/claude-3.5-sonnet',
        assistantMessageId: 'asst-2',
        stream: createFailingStream(['Partial'], new Error('Model unavailable')),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);

    expect(results.get('openai/gpt-4o')!.error).toBeNull();
    expect(results.get('openai/gpt-4o')!.fullContent).toBe('Good response');
    expect(results.get('openai/gpt-4o')!.inlineCost).toBe(0.001);

    expect(results.get('anthropic/claude-3.5-sonnet')!.error).toBeInstanceOf(Error);
    expect(results.get('anthropic/claude-3.5-sonnet')!.error!.message).toBe('Model unavailable');
    expect(results.get('anthropic/claude-3.5-sonnet')!.fullContent).toBe('Partial');
    expect(results.get('anthropic/claude-3.5-sonnet')!.inlineCost).toBeUndefined();
  });

  it('writes model:error for failed models', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: createFailingStream([], new Error('Timeout')),
      },
    ];

    await collectMultiModelStreams(entries, writer);

    const errorEvents = writer.events.filter((e) => e.method === 'writeModelError');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.args[0]).toEqual({
      modelId: 'openai/gpt-4o',
      message: 'Timeout',
      code: 'STREAM_ERROR',
    });
  });

  it('returns empty map for empty entries', async () => {
    const writer = createMockWriter();
    const results = await collectMultiModelStreams([], writer);
    expect(results.size).toBe(0);
  });

  it('captures inlineCost when stream has no content tokens', async () => {
    const writer = createMockWriter();

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* costOnlyStream(): AsyncIterable<{
      content: string;
      inlineCost?: number;
    }> {
      yield { content: 'Hello' };
      yield { content: '', inlineCost: 0.005 };
    }

    const entries: ModelStreamEntry[] = [
      {
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        stream: costOnlyStream(),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);
    expect(results.get('openai/gpt-4o')!.inlineCost).toBe(0.005);
  });
});
