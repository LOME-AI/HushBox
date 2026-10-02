import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { onPauseHandlers, disposePredictionSession } = vi.hoisted(() => ({
  onPauseHandlers: [] as (() => void)[],
  disposePredictionSession: vi.fn(),
}));

vi.mock('@/capacitor/hooks/use-app-lifecycle', () => ({
  useAppLifecycle: (callbacks?: { onPause?: () => void }): void => {
    if (callbacks?.onPause !== undefined) onPauseHandlers.push(callbacks.onPause);
  },
}));

vi.mock('./prediction-session', () => ({ disposePredictionSession }));

import { usePredictionSessionDisposal } from './use-prediction-session-disposal';

beforeEach(() => {
  onPauseHandlers.length = 0;
  disposePredictionSession.mockClear();
});

describe('usePredictionSessionDisposal', () => {
  it('drops the shared session when the app goes to the background', () => {
    renderHook(() => {
      usePredictionSessionDisposal();
    });
    for (const handler of onPauseHandlers) handler();
    expect(disposePredictionSession).toHaveBeenCalledTimes(1);
  });

  it('drops nothing while the app stays in the foreground', () => {
    renderHook(() => {
      usePredictionSessionDisposal();
    });
    expect(disposePredictionSession).not.toHaveBeenCalled();
  });
});
