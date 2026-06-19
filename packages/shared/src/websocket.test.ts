import { describe, it, expect } from 'vitest';

import { WS_HEARTBEAT_PING_MESSAGE, WS_HEARTBEAT_PONG_MESSAGE } from './websocket.js';

describe('websocket heartbeat messages', () => {
  it('serializes the ping message to the exact wire string the DO auto-response matches', () => {
    expect(WS_HEARTBEAT_PING_MESSAGE).toBe('{"type":"ping"}');
  });

  it('serializes the pong message to the exact wire string the DO auto-response replies with', () => {
    expect(WS_HEARTBEAT_PONG_MESSAGE).toBe('{"type":"pong"}');
  });
});
