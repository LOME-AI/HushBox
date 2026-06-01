import { create } from 'zustand';

interface AsyncActivityState {
  /**
   * Live count of `useAsyncAction.run(...)` invocations that have started
   * and not yet resolved (success or failure). Drives the app-level
   * "settled" signal so e2e assertions wrapped in `settled-expect` wait
   * for raw-fetch-based actions (auth resend, recovery save, etc.) to
   * complete before short-circuiting. Without this, an `expect(...)` call
   * after one of those actions would see the app as idle while the
   * underlying `fetch()` is still in flight and pre-throw "App settled
   * but assertion not satisfied".
   */
  activeCount: number;
  begin: () => void;
  end: () => void;
}

export const useAsyncActivityStore = create<AsyncActivityState>((set) => ({
  activeCount: 0,
  begin: () => {
    set((state) => ({
      activeCount: state.activeCount + 1,
    }));
  },
  end: () => {
    set((state) => ({
      activeCount: Math.max(0, state.activeCount - 1),
    }));
  },
}));
