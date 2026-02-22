import { describe, it, expect, vi } from 'vitest';
import { createEvent, type RealtimeEvent } from '@hushbox/realtime/events';
import { broadcastToRoom } from './broadcast.js';
import type { Bindings } from '../types.js';

function createMockEvent(): RealtimeEvent {
  return createEvent('message:new', {
    messageId: 'msg-123',
    conversationId: 'conv-456',
    senderType: 'user',
    senderId: 'user-789',
  });
}

interface MockStub {
  fetch: ReturnType<typeof vi.fn>;
}

interface MockNamespace {
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function createMockDONamespace(sentCount: number): {
  namespace: MockNamespace;
  stub: MockStub;
  id: object;
} {
  const id = { toString: () => 'mock-do-id' };
  const stub: MockStub = {
    fetch: vi.fn().mockResolvedValue(Response.json({ sent: sentCount })),
  };
  const namespace: MockNamespace = {
    idFromName: vi.fn().mockReturnValue(id),
    get: vi.fn().mockReturnValue(stub),
  };

  return { namespace, stub, id };
}

describe('broadcastToRoom', () => {
  it('returns { sent: 0 } when CONVERSATION_ROOM binding is unavailable', async () => {
    const env = {} as Bindings;
    const event = createMockEvent();

    const result = await broadcastToRoom(env, 'conv-456', event);

    expect(result).toEqual({ sent: 0 });
  });

  it('calls idFromName with conversationId', async () => {
    const { namespace } = createMockDONamespace(3);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    await broadcastToRoom(env, 'conv-456', event);

    expect(namespace.idFromName).toHaveBeenCalledWith('conv-456');
  });

  it('calls stub.fetch with POST /broadcast and JSON body', async () => {
    const { namespace, stub, id } = createMockDONamespace(2);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    await broadcastToRoom(env, 'conv-456', event);

    expect(namespace.get).toHaveBeenCalledWith(id);
    expect(stub.fetch).toHaveBeenCalledOnce();

    const fetchCall = stub.fetch.mock.calls[0] as [Request];
    const request = fetchCall[0];
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/broadcast');

    const body: unknown = await request.json();
    expect(body).toMatchObject({
      type: 'message:new',
      messageId: 'msg-123',
      conversationId: 'conv-456',
      senderType: 'user',
      senderId: 'user-789',
    });
  });

  it('returns sent count from DO response', async () => {
    const { namespace } = createMockDONamespace(5);
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    const result = await broadcastToRoom(env, 'conv-456', event);

    expect(result).toEqual({ sent: 5 });
  });

  it('propagates errors from DO fetch', async () => {
    const id = { toString: () => 'mock-do-id' };
    const stub: MockStub = {
      fetch: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    };
    const namespace: MockNamespace = {
      idFromName: vi.fn().mockReturnValue(id),
      get: vi.fn().mockReturnValue(stub),
    };
    const env = { CONVERSATION_ROOM: namespace } as unknown as Bindings;
    const event = createMockEvent();

    await expect(broadcastToRoom(env, 'conv-456', event)).rejects.toThrow('DO unavailable');
  });
});
