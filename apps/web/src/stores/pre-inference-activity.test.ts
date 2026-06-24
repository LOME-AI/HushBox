import { describe, it, expect, beforeEach } from 'vitest';
import { usePreInferenceActivityStore } from './pre-inference-activity.js';

describe('usePreInferenceActivityStore', () => {
  beforeEach(() => {
    usePreInferenceActivityStore.setState({ preInferenceStagesSeen: 0 });
  });

  it('starts at zero', () => {
    expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(0);
  });

  it('increments monotonically on each markStageSeen', () => {
    const { markStageSeen } = usePreInferenceActivityStore.getState();
    markStageSeen();
    markStageSeen();
    expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(2);
  });
});
