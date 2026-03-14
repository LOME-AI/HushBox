import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamingActivityStore } from './streaming-activity.js';

describe('useStreamingActivityStore', () => {
  beforeEach(() => {
    useStreamingActivityStore.setState({ activeStreams: 0 });
  });

  it('starts with zero active streams', () => {
    const state = useStreamingActivityStore.getState();
    expect(state.activeStreams).toBe(0);
  });

  it('increments active streams on startStream', () => {
    useStreamingActivityStore.getState().startStream();

    expect(useStreamingActivityStore.getState().activeStreams).toBe(1);
  });

  it('decrements active streams on endStream', () => {
    useStreamingActivityStore.getState().startStream();
    useStreamingActivityStore.getState().endStream();

    expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
  });

  it('tracks multiple concurrent streams', () => {
    useStreamingActivityStore.getState().startStream();
    useStreamingActivityStore.getState().startStream();

    expect(useStreamingActivityStore.getState().activeStreams).toBe(2);

    useStreamingActivityStore.getState().endStream();

    expect(useStreamingActivityStore.getState().activeStreams).toBe(1);
  });

  it('never goes below zero', () => {
    useStreamingActivityStore.getState().endStream();

    expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
  });
});
