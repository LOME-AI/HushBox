import { describe, expect, it } from 'vitest';
import { ReplayBuffer } from './replay-buffer.js';
import type { FlowStreamEvent } from '@hushbox/shared';

function event(streamId: string, cursor: number, content = 'x'): FlowStreamEvent {
  return { streamId, cursor, event: { kind: 'text-delta', index: 0, content } };
}

function buffer(maxStreamBytes = 10_000): ReplayBuffer {
  return new ReplayBuffer({ maxStreamBytes });
}

describe('append', () => {
  it('buffers an event within the byte budget', () => {
    expect(buffer().append(event('s1', 1))).toBe('buffered');
  });

  it('throws when a cursor does not increase strictly', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 2));
    expect(() => replayBuffer.append(event('s1', 2))).toThrow(/cursor/);
  });

  it('throws when the first cursor of a stream is below one', () => {
    expect(() => buffer().append(event('s1', 0))).toThrow(/cursor/);
  });
});

describe('resume', () => {
  it('replays every buffered event from lastEventId zero in order', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1, 'a'));
    replayBuffer.append(event('s1', 2, 'b'));
    const result = replayBuffer.resume('s1', 0);
    expect(result).toEqual({ kind: 'replay', events: [event('s1', 1, 'a'), event('s1', 2, 'b')] });
  });

  it('replays only events after the given cursor', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1, 'a'));
    replayBuffer.append(event('s1', 2, 'b'));
    replayBuffer.append(event('s1', 3, 'c'));
    const result = replayBuffer.resume('s1', 2);
    expect(result).toEqual({ kind: 'replay', events: [event('s1', 3, 'c')] });
  });

  it('returns an empty replay when the client is fully caught up', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1));
    expect(replayBuffer.resume('s1', 1)).toEqual({ kind: 'replay', events: [] });
  });

  it('keeps streams isolated from each other', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1, 'a'));
    replayBuffer.append(event('s2', 1, 'b'));
    expect(replayBuffer.resume('s1', 0)).toEqual({
      kind: 'replay',
      events: [event('s1', 1, 'a')],
    });
  });

  it('reports an unknown stream as gone', () => {
    expect(buffer().resume('missing', 0)).toEqual({ kind: 'gone' });
  });

  it('reports a cursor beyond the buffered tail as gone', () => {
    const replayBuffer = buffer();
    replayBuffer.append(event('s1', 1));
    expect(replayBuffer.resume('s1', 5)).toEqual({ kind: 'gone' });
  });
});

describe('overflow', () => {
  it('drops replay for a stream that exceeds its byte budget', () => {
    const replayBuffer = buffer(100);
    replayBuffer.append(event('s1', 1, 'a'.repeat(200)));
    expect(replayBuffer.resume('s1', 0)).toEqual({ kind: 'gone' });
  });

  it('reports the overflowing append as dropped', () => {
    const replayBuffer = buffer(100);
    expect(replayBuffer.append(event('s1', 1, 'a'.repeat(200)))).toBe('dropped');
  });

  it('keeps an overflowed stream gone for later appends', () => {
    const replayBuffer = buffer(100);
    replayBuffer.append(event('s1', 1, 'a'.repeat(200)));
    expect(replayBuffer.append(event('s1', 2, 'b'))).toBe('dropped');
    expect(replayBuffer.resume('s1', 0)).toEqual({ kind: 'gone' });
  });

  it('leaves other streams replayable when one overflows', () => {
    const replayBuffer = buffer(100);
    replayBuffer.append(event('s1', 1, 'a'.repeat(200)));
    replayBuffer.append(event('s2', 1, 'b'));
    expect(replayBuffer.resume('s2', 0)).toEqual({ kind: 'replay', events: [event('s2', 1, 'b')] });
  });
});

function bulk(streamId: string, cursor: number, size: number): FlowStreamEvent {
  return event(streamId, cursor, 'a'.repeat(size));
}

function finish(streamId: string, cursor: number): FlowStreamEvent {
  return {
    streamId,
    cursor,
    event: {
      kind: 'finish',
      metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
    },
  };
}

function runBuffer(maxRunBytes: number, maxStreamBytes = 1_000_000): ReplayBuffer {
  return new ReplayBuffer({ maxStreamBytes, maxRunBytes });
}

describe('run byte budget', () => {
  it('buffers every stream when no run budget is given', () => {
    const replayBuffer = new ReplayBuffer({ maxStreamBytes: 1_000_000 });
    for (let index = 1; index <= 10; index += 1) {
      replayBuffer.append(bulk(`s${String(index)}`, 1, 10_000));
    }
    for (let index = 1; index <= 10; index += 1) {
      expect(replayBuffer.resume(`s${String(index)}`, 0)).toEqual({
        kind: 'replay',
        events: [bulk(`s${String(index)}`, 1, 10_000)],
      });
    }
  });

  it('evicts a finished stream when the run total crosses the budget', () => {
    const replayBuffer = runBuffer(25_000);
    replayBuffer.append(bulk('s1', 1, 10_000));
    replayBuffer.append(finish('s1', 2));
    replayBuffer.append(bulk('s2', 1, 10_000));
    replayBuffer.append(finish('s2', 2));
    replayBuffer.append(bulk('s3', 1, 10_000));
    expect(replayBuffer.resume('s1', 0)).toEqual({ kind: 'gone' });
  });

  it('keeps the streams the budget still affords', () => {
    const replayBuffer = runBuffer(25_000);
    replayBuffer.append(bulk('s1', 1, 10_000));
    replayBuffer.append(finish('s1', 2));
    replayBuffer.append(bulk('s2', 1, 10_000));
    replayBuffer.append(finish('s2', 2));
    replayBuffer.append(bulk('s3', 1, 10_000));
    expect(replayBuffer.resume('s2', 1)).toEqual({ kind: 'replay', events: [finish('s2', 2)] });
    expect(replayBuffer.resume('s3', 0)).toEqual({
      kind: 'replay',
      events: [bulk('s3', 1, 10_000)],
    });
  });

  it('evicts the stream that finished first, not the one that started first', () => {
    const replayBuffer = runBuffer(25_000);
    replayBuffer.append(bulk('s1', 1, 10_000));
    replayBuffer.append(bulk('s2', 1, 10_000));
    replayBuffer.append(finish('s2', 2));
    replayBuffer.append(finish('s1', 2));
    replayBuffer.append(bulk('s3', 1, 10_000));
    expect(replayBuffer.resume('s2', 0)).toEqual({ kind: 'gone' });
    expect(replayBuffer.resume('s1', 1)).toEqual({ kind: 'replay', events: [finish('s1', 2)] });
  });

  it('evicts a finished stream before a larger live stream', () => {
    const replayBuffer = runBuffer(10_700);
    replayBuffer.append(bulk('s1', 1, 5000));
    replayBuffer.append(bulk('s2', 1, 500));
    replayBuffer.append(finish('s2', 2));
    replayBuffer.append(bulk('s1', 2, 5000));
    expect(replayBuffer.resume('s2', 0)).toEqual({ kind: 'gone' });
    expect(replayBuffer.resume('s1', 1)).toEqual({
      kind: 'replay',
      events: [bulk('s1', 2, 5000)],
    });
  });

  it('evicts the largest live stream when no stream has finished', () => {
    const replayBuffer = runBuffer(15_000);
    replayBuffer.append(bulk('s1', 1, 2000));
    replayBuffer.append(bulk('s2', 1, 12_000));
    replayBuffer.append(bulk('s3', 1, 2000));
    expect(replayBuffer.resume('s2', 0)).toEqual({ kind: 'gone' });
    expect(replayBuffer.resume('s1', 0)).toEqual({
      kind: 'replay',
      events: [bulk('s1', 1, 2000)],
    });
    expect(replayBuffer.resume('s3', 0)).toEqual({
      kind: 'replay',
      events: [bulk('s3', 1, 2000)],
    });
  });

  it('evicts repeatedly until the run total is back within the budget', () => {
    const replayBuffer = runBuffer(5000);
    replayBuffer.append(bulk('s1', 1, 2000));
    replayBuffer.append(finish('s1', 2));
    replayBuffer.append(bulk('s2', 1, 2000));
    replayBuffer.append(finish('s2', 2));
    replayBuffer.append(bulk('s3', 1, 4000));
    expect(replayBuffer.resume('s1', 0)).toEqual({ kind: 'gone' });
    expect(replayBuffer.resume('s2', 0)).toEqual({ kind: 'gone' });
    expect(replayBuffer.resume('s3', 0)).toEqual({
      kind: 'replay',
      events: [bulk('s3', 1, 4000)],
    });
  });

  it('reports the append as dropped when it evicts its own stream', () => {
    const replayBuffer = runBuffer(5000);
    expect(replayBuffer.append(bulk('s1', 1, 6000))).toBe('dropped');
  });

  it('keeps an evicted stream gone for later appends', () => {
    const replayBuffer = runBuffer(5000);
    replayBuffer.append(bulk('s1', 1, 6000));
    expect(replayBuffer.append(event('s1', 2))).toBe('dropped');
    expect(replayBuffer.resume('s1', 0)).toEqual({ kind: 'gone' });
  });

  it('releases the run total when a stream overflows its own byte budget', () => {
    const replayBuffer = runBuffer(5000, 3000);
    replayBuffer.append(bulk('s1', 1, 5000));
    expect(replayBuffer.append(bulk('s2', 1, 2000))).toBe('buffered');
    expect(replayBuffer.resume('s2', 0)).toEqual({
      kind: 'replay',
      events: [bulk('s2', 1, 2000)],
    });
  });
});
