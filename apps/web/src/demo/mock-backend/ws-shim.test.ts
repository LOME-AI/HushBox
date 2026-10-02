import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UPGRADE_TICKET_PARAM } from '@hushbox/shared';
import {
  DemoConversationSocket,
  installWebSocketShim,
  emitDemoRealtimeEvent,
  emitDemoTurnFrames,
  stopDemoTurnFrames,
} from './ws-shim';

describe('DemoConversationSocket', () => {
  it('opens and signals fan-out readiness, then stays open', async () => {
    const socket = new DemoConversationSocket('ws://localhost/conversations/demo-group/websocket');
    let opened = false;
    let ready = false;
    socket.addEventListener('open', () => {
      opened = true;
    });
    socket.addEventListener('message', (event) => {
      if ((event as { data?: string }).data === '{"type":"ready"}') ready = true;
    });

    await Promise.resolve();

    expect(opened).toBe(true);
    expect(ready).toBe(true);
    expect(socket.readyState).toBe(DemoConversationSocket.OPEN);
  });

  it('never emits close on its own and accepts sends without throwing', async () => {
    const socket = new DemoConversationSocket('ws://localhost/conversations/x/websocket');
    let closed = false;
    socket.addEventListener('close', () => {
      closed = true;
    });

    await Promise.resolve();

    expect(() => {
      socket.send();
    }).not.toThrow();
    expect(closed).toBe(false);
  });

  it('delivers an emitted realtime event as a JSON message to the matching conversation socket', () => {
    const socket = new DemoConversationSocket(
      `ws://localhost/conversations/demo-group/websocket?${UPGRADE_TICKET_PARAM}=abc`
    );
    const received: string[] = [];
    socket.addEventListener('message', (event) => {
      const data = (event as { data?: string }).data;
      if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
    });

    const delivered = emitDemoRealtimeEvent('demo-group', { type: 'typing:start', userId: 'amir' });

    expect(delivered).toBe(true);
    expect(received).toEqual(['{"type":"event","event":{"type":"typing:start","userId":"amir"}}']);
  });

  it('wraps an event in the event frame the client parses', () => {
    const socket = new DemoConversationSocket('ws://localhost/conversations/wrap/websocket');
    const received: string[] = [];
    socket.addEventListener('message', (event) => {
      const data = (event as { data?: string }).data;
      if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
    });

    socket.emitEventFrame({ type: 'typing:stop', userId: 'kai' });

    expect(received).toEqual(['{"type":"event","event":{"type":"typing:stop","userId":"kai"}}']);
  });

  it('returns false for a conversation with no open socket (incl. after close)', () => {
    expect(emitDemoRealtimeEvent('never-opened', { type: 'x' })).toBe(false);
    const socket = new DemoConversationSocket(
      'ws://localhost/conversations/demo-closeme/websocket'
    );
    socket.close();
    expect(emitDemoRealtimeEvent('demo-closeme', { type: 'x' })).toBe(false);
  });

  it('parses an empty conversation id from a URL missing the conversations segment', async () => {
    const socket = new DemoConversationSocket('ws://localhost/no-conversation-segment');
    await Promise.resolve();
    expect(socket.readyState).toBe(DemoConversationSocket.OPEN);
    // The empty-id socket is registered and reachable under the empty key.
    expect(emitDemoRealtimeEvent('', { type: 'x' })).toBe(true);
    socket.close();
  });

  it('close leaves a newer socket for the same conversation registered', () => {
    const first = new DemoConversationSocket('ws://localhost/conversations/dup/websocket');
    const second = new DemoConversationSocket('ws://localhost/conversations/dup/websocket');
    // The second construction overwrote the registry entry for `dup`.
    first.close();
    expect(first.readyState).toBe(DemoConversationSocket.CLOSED);
    // Closing the stale socket must not evict the live one.
    expect(emitDemoRealtimeEvent('dup', { type: 'x' })).toBe(true);
    second.close();
  });

  it('removeEventListener detaches a listener before it fires', async () => {
    const socket = new DemoConversationSocket('ws://localhost/conversations/x/websocket');
    let opens = 0;
    const onOpen = (): void => {
      opens += 1;
    };
    socket.addEventListener('open', onOpen);
    socket.removeEventListener('open', onOpen);

    await Promise.resolve();

    expect(opens).toBe(0);
  });
});

describe('installWebSocketShim', () => {
  let original: typeof globalThis.WebSocket;

  beforeEach(() => {
    original = globalThis.WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = original;
  });

  it('routes conversation sockets to the fake and passes others through', () => {
    const calls: string[] = [];
    class FakeOriginal {
      readonly url: string;
      constructor(url: string) {
        this.url = url;
        calls.push(url);
      }
    }
    globalThis.WebSocket = FakeOriginal as unknown as typeof WebSocket;

    const uninstall = installWebSocketShim();

    const conversationSocket = new WebSocket('ws://localhost/conversations/demo-group/websocket');
    expect(conversationSocket).toBeInstanceOf(DemoConversationSocket);
    expect(calls).toHaveLength(0);

    const hmrSocket = new WebSocket('ws://localhost/hmr');
    expect(hmrSocket).toBeInstanceOf(FakeOriginal);
    expect(calls).toEqual(['ws://localhost/hmr']);

    uninstall();
    expect(globalThis.WebSocket).toBe(FakeOriginal);
  });
});

describe('emitDemoTurnFrames', () => {
  it('streams frames to the conversation socket on a timer', async () => {
    vi.useFakeTimers();
    try {
      const socket = new DemoConversationSocket('ws://localhost/conversations/demo-run/websocket');
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });

      emitDemoTurnFrames(
        'demo-run',
        [
          { type: 'run-started', runId: 'r1' },
          {
            type: 'stream',
            streamId: 's1',
            cursor: 1,
            event: { kind: 'stream-start', modelId: 'demo' },
          } as never,
          { type: 'run-finished', runId: 'r1', outcome: { outcome: 'succeeded' } } as never,
        ],
        { delayMs: 10 }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(received).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(received).toHaveLength(3);
      expect(JSON.parse(received[0] ?? '')).toEqual({ type: 'run-started', runId: 'r1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops without emitting when there are no frames to push', async () => {
    vi.useFakeTimers();
    try {
      const socket = new DemoConversationSocket(
        'ws://localhost/conversations/demo-empty/websocket'
      );
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });

      emitDemoTurnFrames('demo-empty', [], { delayMs: 10 });
      await vi.advanceTimersByTimeAsync(50);

      expect(received).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the lead delay before the first reply frame for a media generation', async () => {
    vi.useFakeTimers();
    try {
      const socket = new DemoConversationSocket('ws://localhost/conversations/demo-lead/websocket');
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });

      emitDemoTurnFrames(
        'demo-lead',
        [
          { type: 'run-started', runId: 'r3' },
          {
            type: 'stream',
            streamId: 's1',
            cursor: 1,
            event: { kind: 'media-start', modality: 'image', mimeType: 'image/png' },
          } as never,
          { type: 'run-finished', runId: 'r3', outcome: { outcome: 'succeeded' } } as never,
        ],
        { delayMs: 10, leadDelayMs: 500 }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(received).toHaveLength(2);
      // The third frame waits the lead delay, not the inter-token delay.
      await vi.advanceTimersByTimeAsync(10);
      expect(received).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(490);
      expect(received).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up once the socket has stayed absent past the retry bound', async () => {
    vi.useFakeTimers();
    try {
      emitDemoTurnFrames('never-opens', [{ type: 'run-started', runId: 'r4' }], { delayMs: 10 });
      // Nothing is listening on `never-opens`; past the bound the chain is dead.
      await vi.advanceTimersByTimeAsync(2100);

      const socket = new DemoConversationSocket(
        'ws://localhost/conversations/never-opens/websocket'
      );
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });

      await vi.advanceTimersByTimeAsync(1000);

      const delivered = [...received];
      // Deregister before asserting: an open socket outlives the test, and a
      // retry of a failing run would then find one already there and never
      // exercise the retry path at all.
      socket.close();
      expect(delivered).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a disposer that drops the frames still queued behind it', async () => {
    vi.useFakeTimers();
    try {
      const socket = new DemoConversationSocket(
        'ws://localhost/conversations/demo-disposed/websocket'
      );
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });

      const stop = emitDemoTurnFrames(
        'demo-disposed',
        [
          { type: 'run-started', runId: 'r5' },
          { type: 'run-finished', runId: 'r5', outcome: { outcome: 'succeeded' } } as never,
        ],
        { delayMs: 10 }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(1);

      stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops an in-flight chain addressed by its conversation id', async () => {
    vi.useFakeTimers();
    try {
      const socket = new DemoConversationSocket(
        'ws://localhost/conversations/demo-stopped/websocket'
      );
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });

      emitDemoTurnFrames(
        'demo-stopped',
        [
          { type: 'run-started', runId: 'r6' },
          { type: 'run-finished', runId: 'r6', outcome: { outcome: 'succeeded' } } as never,
        ],
        { delayMs: 10 }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(1);

      stopDemoTurnFrames('demo-stopped');
      await vi.advanceTimersByTimeAsync(1000);

      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the live chain reachable when an older chain for the same conversation gives up', async () => {
    vi.useFakeTimers();
    try {
      // Both chains are addressed by conversation id, and the older one outlives
      // the younger one's registration only if it deregisters itself and nothing else.
      emitDemoTurnFrames('demo-relay', [{ type: 'run-started', runId: 'r7' }], { delayMs: 100 });
      await vi.advanceTimersByTimeAsync(1500);
      emitDemoTurnFrames(
        'demo-relay',
        [
          { type: 'run-started', runId: 'r8' },
          { type: 'stream', streamId: 's1', cursor: 1, event: { kind: 'stream-end' } } as never,
          { type: 'run-finished', runId: 'r8', outcome: { outcome: 'succeeded' } } as never,
        ],
        { delayMs: 100 }
      );
      // Past the older chain's retry bound: it gives up here.
      await vi.advanceTimersByTimeAsync(500);

      const socket = new DemoConversationSocket(
        'ws://localhost/conversations/demo-relay/websocket'
      );
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(received).toHaveLength(1);

      stopDemoTurnFrames('demo-relay');
      await vi.advanceTimersByTimeAsync(1000);

      const delivered = [...received];
      socket.close();
      expect(delivered).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries until the socket exists', async () => {
    vi.useFakeTimers();
    try {
      emitDemoTurnFrames('late-room', [{ type: 'run-started', runId: 'r2' }], { delayMs: 10 });
      await vi.advanceTimersByTimeAsync(0);

      const socket = new DemoConversationSocket('ws://localhost/conversations/late-room/websocket');
      const received: string[] = [];
      socket.addEventListener('message', (event) => {
        const data = (event as { data?: string }).data;
        if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
      });

      await vi.advanceTimersByTimeAsync(60);
      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
