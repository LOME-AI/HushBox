import { describe, it, expect } from 'vitest';
import { createEvictUserPort } from './evict-user-port.js';
import type { Bindings } from '../../lib/context/index.js';
import type { Redis } from '@upstash/redis';

describe('createEvictUserPort', () => {
  function fakeRoomNamespace(): unknown {
    return {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.resolve(Response.json({ closed: 1 })) }),
    };
  }

  it('fans eviction over the user active-room set when the realtime binding is present', async () => {
    const smembersKeys: string[] = [];
    const redis = {
      smembers: (key: string) => {
        smembersKeys.push(key);
        return Promise.resolve(['conv-a', 'conv-b']);
      },
    } as unknown as Redis;
    const env = { CONVERSATION_ROOM: fakeRoomNamespace() } as unknown as Bindings;

    const port = createEvictUserPort(redis, env);
    await expect(port.evictUser('user-1')).resolves.toBeUndefined();
    expect(smembersKeys).toHaveLength(1);
  });

  it('drops a refused room eviction without failing the fan-out', async () => {
    const attempts: string[] = [];
    const redis = { smembers: () => Promise.resolve(['conv-a']) } as unknown as Redis;
    const refusingNamespace = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: (): Promise<Response> => {
          attempts.push(id);
          return Promise.resolve(new Response('unavailable', { status: 503 }));
        },
      }),
    };
    const env = { CONVERSATION_ROOM: refusingNamespace } as unknown as Bindings;

    const port = createEvictUserPort(redis, env);

    // The room was reached and refused; the fan-out drops the failure, because
    // the missed socket is cut at its next broadcast.
    await expect(port.evictUser('user-1')).resolves.toBeUndefined();
    expect(attempts).toEqual(['conv-a']);
  });

  it('carries the session id into each room eviction when one is given', async () => {
    const bodies: unknown[] = [];
    const redis = { smembers: () => Promise.resolve(['conv-a', 'conv-b']) } as unknown as Redis;
    const recordingNamespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (_url: string, init?: RequestInit): Promise<Response> => {
          // The real DO client always posts a JSON string body (postJson).
          bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
          return Promise.resolve(Response.json({ closed: 1 }));
        },
      }),
    };
    const env = { CONVERSATION_ROOM: recordingNamespace } as unknown as Bindings;

    const port = createEvictUserPort(redis, env);
    await port.evictUser('user-1', 'session-1');
    expect(bodies).toEqual([
      { principalId: 'user-1', sessionId: 'session-1' },
      { principalId: 'user-1', sessionId: 'session-1' },
    ]);
  });

  it('sends no session id when the eviction is account-wide', async () => {
    const bodies: unknown[] = [];
    const redis = { smembers: () => Promise.resolve(['conv-a']) } as unknown as Redis;
    const recordingNamespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (_url: string, init?: RequestInit): Promise<Response> => {
          // The real DO client always posts a JSON string body (postJson).
          bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
          return Promise.resolve(Response.json({ closed: 2 }));
        },
      }),
    };
    const env = { CONVERSATION_ROOM: recordingNamespace } as unknown as Bindings;

    const port = createEvictUserPort(redis, env);
    await port.evictUser('user-1');
    expect(bodies).toEqual([{ principalId: 'user-1' }]);
  });

  it('degrades to a no-op when the realtime binding is absent', async () => {
    const redis = { smembers: () => Promise.resolve([]) } as unknown as Redis;
    const port = createEvictUserPort(redis, {} as Bindings);
    await expect(port.evictUser('user-1')).resolves.toBeUndefined();
  });
});
