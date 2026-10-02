import { create } from 'zustand';

interface StreamCycleActivityState {
  streamsCompleted: number;
  markStreamCycleComplete: () => void;
}

/**
 * Monotonic count of completed stream cycles (a streaming turn finished AND the
 * server committed its messages — i.e. `persistingMessageIds` drained to empty).
 * Exposed as `data-streams-completed` so E2E can capture a baseline before an
 * action and wait for it to advance.
 *
 * Incremented from `useChatPageState`'s layout effect, gated on a
 * synchronously-set "cycle pending" ref. That ref records the stream START
 * (which `MessageList` can miss: under 0-ms mock streaming the whole cycle can
 * collapse into one React batch, so the intermediate `persisting.size > 0` is
 * never committed to a render). Incrementing in a layout effect, after the render
 * where persisting settled to empty committed, keeps the signal coupled to an
 * actual render while remaining immune to that batching. The layout phase puts
 * the increment in the same task as that render, so no reader sees the streaming
 * count at zero beside the pre-cycle count.
 */
export const useStreamCycleActivityStore = create<StreamCycleActivityState>()((set) => ({
  streamsCompleted: 0,
  markStreamCycleComplete: () => {
    set((state) => ({ streamsCompleted: state.streamsCompleted + 1 }));
  },
}));
