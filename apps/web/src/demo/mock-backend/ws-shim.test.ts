import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DemoConversationSocket, installWebSocketShim, emitDemoRealtimeEvent } from './ws-shim';

describe('DemoConversationSocket', () => {
  it('opens and signals fan-out readiness, then stays open', async () => {
    const socket = new DemoConversationSocket('ws://localhost/api/ws/demo-group');
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
    const socket = new DemoConversationSocket('ws://localhost/api/ws/x');
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
    const socket = new DemoConversationSocket('ws://localhost/api/ws/demo-group?linkPublicKey=abc');
    const received: string[] = [];
    socket.addEventListener('message', (event) => {
      const data = (event as { data?: string }).data;
      if (data !== undefined && data !== '{"type":"ready"}') received.push(data);
    });

    const delivered = emitDemoRealtimeEvent('demo-group', { type: 'typing:start', userId: 'amir' });

    expect(delivered).toBe(true);
    expect(received).toEqual(['{"type":"typing:start","userId":"amir"}']);
  });

  it('returns false for a conversation with no open socket (incl. after close)', () => {
    expect(emitDemoRealtimeEvent('never-opened', { type: 'x' })).toBe(false);
    const socket = new DemoConversationSocket('ws://localhost/api/ws/demo-closeme');
    socket.close();
    expect(emitDemoRealtimeEvent('demo-closeme', { type: 'x' })).toBe(false);
  });

  it('removeEventListener detaches a listener before it fires', async () => {
    const socket = new DemoConversationSocket('ws://localhost/api/ws/x');
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

    const conversationSocket = new WebSocket('ws://localhost/api/ws/demo-group');
    expect(conversationSocket).toBeInstanceOf(DemoConversationSocket);
    expect(calls).toHaveLength(0);

    const hmrSocket = new WebSocket('ws://localhost/hmr');
    expect(hmrSocket).toBeInstanceOf(FakeOriginal);
    expect(calls).toEqual(['ws://localhost/hmr']);

    uninstall();
    expect(globalThis.WebSocket).toBe(FakeOriginal);
  });
});
