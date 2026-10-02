// GET /chat/trial/websocket: the server-derived trial room and who may upgrade to it.
import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  STARTED,
  cookie,
  fakeRealtime,
  getPath,
  recordingUpgrade,
  seedUser,
} from '../../test-support/chat-routes.integration.setup.js';
import type { RealtimeBroadcast } from '../conversations/index.js';

describe('chat route: GET /chat/trial/websocket', () => {
  it('upgrades a trial session to its own server-derived trial room', async () => {
    const token = crypto.randomUUID();
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath('/chat/trial/websocket', realtime, { 'x-trial-token': token });
    // The port double answers a 200 stand-in for the DO's real 101 (undici
    // cannot construct a sub-200 Response); the route forwards it untouched.
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { conversationId: `trial:${token}`, principalId: `trial:${token}`, isGuest: false },
    ]);
  });

  it('forwards the client cursor declaration to the trial room', async () => {
    const declared: (string | null)[] = [];
    const realtime = fakeRealtime(STARTED, {
      upgrade: (_room, _principal, _headers, cursors) => {
        declared.push(cursors);
        return okAsync(new Response(null, { status: 200 }));
      },
    });
    const cursors = '[{"streamId":"s1","lastEventId":3}]';
    const res = await getPath(
      `/chat/trial/websocket?cursors=${encodeURIComponent(cursors)}`,
      realtime,
      { 'x-trial-token': crypto.randomUUID() }
    );
    expect(res.status).toBe(200);
    expect(declared).toEqual([cursors]);
  });

  it('forwards no declaration when the trial client sends no cursors', async () => {
    const declared: (string | null)[] = [];
    const realtime = fakeRealtime(STARTED, {
      upgrade: (_room, _principal, _headers, cursors) => {
        declared.push(cursors);
        return okAsync(new Response(null, { status: 200 }));
      },
    });
    const res = await getPath('/chat/trial/websocket', realtime, {
      'x-trial-token': crypto.randomUUID(),
    });
    expect(res.status).toBe(200);
    expect(declared).toEqual([null]);
  });

  it('mints a fresh trial room when no token is supplied', async () => {
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath('/chat/trial/websocket', realtime, {});
    expect(res.status).toBe(200);
    // A minted session still targets a prefix-scoped self-room: id equals principal.
    expect(calls[0]?.conversationId).toMatch(/^trial:/);
    expect(calls[0]?.principalId).toBe(calls[0]?.conversationId);
  });

  it('upgrades via the trialToken query param when the header is absent (browser WS)', async () => {
    const token = crypto.randomUUID();
    const { calls, realtime } = recordingUpgrade();
    // A browser WebSocket cannot set headers, so the upgrade must honor the
    // query-param credential and land in the SAME room the POST started.
    const res = await getPath(
      `/chat/trial/websocket?trialToken=${encodeURIComponent(token)}`,
      realtime,
      {}
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { conversationId: `trial:${token}`, principalId: `trial:${token}`, isGuest: false },
    ]);
  });

  it('prefers the x-trial-token header over the trialToken query param', async () => {
    const headerToken = crypto.randomUUID();
    const queryToken = crypto.randomUUID();
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath(
      `/chat/trial/websocket?trialToken=${encodeURIComponent(queryToken)}`,
      realtime,
      { 'x-trial-token': headerToken }
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.conversationId).toBe(`trial:${headerToken}`);
  });

  it('derives the room server-side, ignoring client-injected room and principal params', async () => {
    const token = crypto.randomUUID();
    const foreignConversation = crypto.randomUUID();
    const foreignPrincipal = `trial:${crypto.randomUUID()}`;
    const { calls, realtime } = recordingUpgrade();
    // A crafted request injecting conversationId / principalId query params must
    // not retarget the upgrade — only the x-trial-token is honored, and the room
    // is trialRoomName(sessionId), so no trial credential can reach a foreign
    // trial room or any conversation DO.
    const res = await getPath(
      `/chat/trial/websocket?conversationId=${foreignConversation}&principalId=${foreignPrincipal}`,
      realtime,
      { 'x-trial-token': token }
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.conversationId).toBe(`trial:${token}`);
    expect(calls[0]?.principalId).toBe(`trial:${token}`);
    expect(calls[0]?.conversationId).not.toBe(foreignConversation);
    expect(calls[0]?.principalId).not.toBe(foreignPrincipal);
  });

  it('refuses an authenticated caller (belongs on the conversation socket)', async () => {
    const userId = await seedUser();
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath('/chat/trial/websocket', realtime, {
      'x-trial-token': crypto.randomUUID(),
      cookie: await cookie(userId),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'AUTHENTICATED_ON_TRIAL' });
    expect(calls).toEqual([]);
  });

  it('maps a realtime transport failure to 503', async () => {
    const errorRealtime: RealtimeBroadcast = {
      ...fakeRealtime(STARTED),
      upgrade: () => errAsync(unavailableError('conversation room unreachable')),
    };
    const res = await getPath('/chat/trial/websocket', errorRealtime, {
      'x-trial-token': crypto.randomUUID(),
    });
    expect(res.status).toBe(503);
  });
});
