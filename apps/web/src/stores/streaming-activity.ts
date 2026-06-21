import { createCounterStore } from './create-counter-store.js';

export const useStreamingActivityStore = createCounterStore({
  count: 'activeStreams',
  increment: 'startStream',
  decrement: 'endStream',
});
