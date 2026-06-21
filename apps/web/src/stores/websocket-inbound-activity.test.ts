import { describe, it, expect, beforeEach } from 'vitest';
import { useWebsocketInboundActivityStore } from './websocket-inbound-activity.js';

describe('useWebsocketInboundActivityStore', () => {
  beforeEach(() => {
    useWebsocketInboundActivityStore.setState({ pendingInbound: 0 });
  });

  it('exposes the websocket inbound counter API', () => {
    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(0);

    useWebsocketInboundActivityStore.getState().startProcessing();
    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(1);

    useWebsocketInboundActivityStore.getState().endProcessing();
    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(0);
  });
});
