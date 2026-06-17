import { describe, it, expect, vi } from 'vitest';
import { createSSEParser } from '@/lib/sse-client';
import { buildSseTurnFrames, createSseStream } from './sse-shim';

describe('buildSseTurnFrames', () => {
  it('produces start → tokens → model:done → done that the real parser assembles', () => {
    const frames = buildSseTurnFrames({
      userMessageId: 'u1',
      modelId: 'openai/gpt-4o',
      assistantMessageId: 'a1',
      content: 'Hello there, this is a streamed demo reply.',
    });

    const onStart = vi.fn();
    const onModelDone = vi.fn();
    const onDone = vi.fn();
    const parser = createSSEParser({ onStart, onModelDone, onDone });
    for (const f of frames) parser.processChunk(f);

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: 'u1',
        models: [{ modelId: 'openai/gpt-4o', assistantMessageId: 'a1' }],
      })
    );
    expect(parser.getModelContent('openai/gpt-4o')).toBe(
      'Hello there, this is a streamed demo reply.'
    );
    expect(onModelDone).toHaveBeenCalledWith({
      modelId: 'openai/gpt-4o',
      assistantMessageId: 'a1',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('chunks long content into multiple token frames', () => {
    const frames = buildSseTurnFrames({
      userMessageId: 'u1',
      modelId: 'm',
      assistantMessageId: 'a1',
      content: 'x'.repeat(100),
      chunkSize: 10,
    });
    const tokenFrames = frames.filter((f) => f.startsWith('event: token'));
    expect(tokenFrames).toHaveLength(10);
  });
});

describe('createSseStream', () => {
  it('emits the frames as a readable byte stream', async () => {
    const stream = createSseStream(
      ['event: token\ndata: {"modelId":"m","content":"hi"}\n\n', 'event: done\ndata: {}\n\n'],
      0
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    expect(out).toContain('event: token');
    expect(out).toContain('event: done');
  });

  it('applies a one-time generation lead delay after the start frame', async () => {
    vi.useFakeTimers();
    try {
      const stream = createSseStream(
        ['event: start\ndata: {}\n\n', 'event: done\ndata: {}\n\n'],
        0,
        5000
      );
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain('event: start');

      const pending = reader.read();
      // After 4s the 5s lead delay hasn't elapsed, so the read is still pending.
      await vi.advanceTimersByTimeAsync(4000);
      expect(await Promise.race([pending, Promise.resolve('pending')])).toBe('pending');
      // After the full lead delay it resolves with the next frame.
      await vi.advanceTimersByTimeAsync(1100);
      const second = await pending;
      expect(decoder.decode(second.value)).toContain('event: done');
    } finally {
      vi.useRealTimers();
    }
  });
});
