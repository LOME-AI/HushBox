import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseAssistantMessage,
  serializeAssistantStream,
  WEB_SEARCH_TOOL_NAME,
} from '@hushbox/shared';
import { createStreamContentBuilder } from '@/lib/chat/stream-content-builder';
import type { InferenceEvent } from '@hushbox/shared';

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return { ...original, serializeAssistantStream: vi.fn(original.serializeAssistantStream) };
});

const text = (content: string): InferenceEvent => ({ kind: 'text-delta', index: 0, content });
const reasoning = (content: string): InferenceEvent => ({
  kind: 'reasoning-delta',
  index: 0,
  content,
});
const searchCall = (id: string): InferenceEvent => ({
  kind: 'tool-call',
  id,
  name: WEB_SEARCH_TOOL_NAME,
  args: { query: 'q' },
});

describe('createStreamContentBuilder', () => {
  beforeEach(() => {
    vi.mocked(serializeAssistantStream).mockClear();
  });

  it('builds the tree the shared reducer makes from the events fed', () => {
    const builder = createStreamContentBuilder();

    builder.feed(reasoning('think'));
    builder.feed(text('Answer'));

    expect(parseAssistantMessage(builder.take() ?? '')).toEqual([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }] },
      { kind: 'text', text: 'Answer' },
    ]);
  });

  it('serializes once for a burst of events taken together', () => {
    const builder = createStreamContentBuilder();

    for (let index = 0; index < 100; index += 1) builder.feed(text('x'));
    const content = builder.take();

    expect(content).toBe('x'.repeat(100));
    expect(serializeAssistantStream).toHaveBeenCalledTimes(1);
  });

  it('gives nothing to take when no event arrived since the last take', () => {
    const builder = createStreamContentBuilder();
    builder.feed(text('Hi'));
    builder.take();

    expect(builder.take()).toBeUndefined();
    expect(serializeAssistantStream).toHaveBeenCalledTimes(1);
  });

  it('gives nothing to take when an event left the content as it was', () => {
    const builder = createStreamContentBuilder();
    builder.feed(text('Hi'));
    builder.take();

    builder.feed({ kind: 'step-start', step: 1 });

    expect(builder.take()).toBeUndefined();
  });

  it('interrupts a running search when it settles', () => {
    const builder = createStreamContentBuilder();
    builder.feed(searchCall('c1'));

    builder.settle();

    expect(parseAssistantMessage(builder.take() ?? '')).toEqual([
      {
        kind: 'webSearch',
        row: {
          v: 1,
          searches: [{ query: 'q', status: 'interrupted' }],
          notRun: { limit: 0, invalidQuery: 0 },
        },
      },
    ]);
  });

  it('decides held-back text when it settles', () => {
    const builder = createStreamContentBuilder();
    builder.feed(text('<thi'));
    expect(builder.take()).toBeUndefined();

    builder.settle();

    expect(builder.take()).toBe('<thi');
  });

  it('starts from an empty stream after a reset', () => {
    const builder = createStreamContentBuilder();
    builder.feed(text('first attempt'));
    builder.take();

    builder.reset();
    builder.feed(text('second'));

    expect(builder.take()).toBe('second');
  });

  it('gives nothing to take right after a reset', () => {
    const builder = createStreamContentBuilder();
    builder.feed(text('pending'));

    builder.reset();

    expect(builder.take()).toBeUndefined();
  });
});
