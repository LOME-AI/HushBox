import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingActivityStore } from './streaming-activity.js';

describe('useStreamingActivityStore', () => {
  beforeEach(() => {
    useStreamingActivityStore.setState({ activeStreams: 0 });
  });

  it('exposes the streaming counter API', () => {
    expect(useStreamingActivityStore.getState().activeStreams).toBe(0);

    useStreamingActivityStore.getState().startStream();
    expect(useStreamingActivityStore.getState().activeStreams).toBe(1);

    useStreamingActivityStore.getState().endStream();
    expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
  });
});
