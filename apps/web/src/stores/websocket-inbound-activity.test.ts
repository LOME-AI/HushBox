import { describe, it, expect, beforeEach } from 'vitest';
import { useWebsocketInboundActivityStore } from './websocket-inbound-activity.js';

describe('useWebsocketInboundActivityStore', () => {
  beforeEach(() => {
    useWebsocketInboundActivityStore.setState({ pendingInbound: 0 });
  });

  it('starts with zero pending inbound events', () => {
    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(0);
  });

  it('increments pending on startProcessing', () => {
    useWebsocketInboundActivityStore.getState().startProcessing();

    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(1);
  });

  it('decrements pending on endProcessing', () => {
    useWebsocketInboundActivityStore.getState().startProcessing();
    useWebsocketInboundActivityStore.getState().endProcessing();

    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(0);
  });

  it('tracks multiple concurrent inbound events', () => {
    useWebsocketInboundActivityStore.getState().startProcessing();
    useWebsocketInboundActivityStore.getState().startProcessing();

    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(2);

    useWebsocketInboundActivityStore.getState().endProcessing();

    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(1);
  });

  it('never goes below zero', () => {
    useWebsocketInboundActivityStore.getState().endProcessing();

    expect(useWebsocketInboundActivityStore.getState().pendingInbound).toBe(0);
  });
});
