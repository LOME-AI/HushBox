import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamCycleActivityStore } from './stream-cycle-activity.js';

describe('useStreamCycleActivityStore', () => {
  beforeEach(() => {
    useStreamCycleActivityStore.setState({ streamsCompleted: 0 });
  });

  it('starts at zero', () => {
    expect(useStreamCycleActivityStore.getState().streamsCompleted).toBe(0);
  });

  it('increments monotonically on each markStreamCycleComplete', () => {
    const { markStreamCycleComplete } = useStreamCycleActivityStore.getState();
    markStreamCycleComplete();
    markStreamCycleComplete();
    expect(useStreamCycleActivityStore.getState().streamsCompleted).toBe(2);
  });
});
