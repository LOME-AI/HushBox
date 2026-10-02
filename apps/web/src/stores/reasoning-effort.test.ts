// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useReasoningEffortStore, REASONING_EFFORT_STORAGE_KEY } from '@/stores/reasoning-effort';

describe('useReasoningEffortStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'auto' });
  });

  it('defaults the preference to auto', () => {
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
  });

  it('setReasoningEffort updates the preference', () => {
    useReasoningEffortStore.getState().setReasoningEffort('high');
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('high');
  });

  it('persists under the reasoning-effort storage key', () => {
    expect(useReasoningEffortStore.persist.getOptions().name).toBe(REASONING_EFFORT_STORAGE_KEY);
  });

  it('setEnabledEffortChoices publishes the graded set', () => {
    useReasoningEffortStore.getState().setEnabledEffortChoices(['low', 'medium']);
    expect(useReasoningEffortStore.getState().enabledEffortChoices).toEqual(['low', 'medium']);
  });

  it('ignores a republish of the same grading, so equal writers cannot churn', () => {
    useReasoningEffortStore.getState().setEnabledEffortChoices(['low', 'medium']);
    const first = useReasoningEffortStore.getState().enabledEffortChoices;
    useReasoningEffortStore.getState().setEnabledEffortChoices(['low', 'medium']);
    expect(useReasoningEffortStore.getState().enabledEffortChoices).toBe(first);
  });

  it('keeps the graded set out of storage — it is a verdict about a moment', () => {
    useReasoningEffortStore.getState().setReasoningEffort('high');
    useReasoningEffortStore.getState().setEnabledEffortChoices(['low']);
    const partialize = useReasoningEffortStore.persist.getOptions().partialize;
    expect(partialize?.(useReasoningEffortStore.getState())).toEqual({
      preferredReasoningEffort: 'high',
    });
  });
});
