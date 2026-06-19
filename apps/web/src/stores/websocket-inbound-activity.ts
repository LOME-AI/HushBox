import { createCounterStore } from './create-counter-store.js';

export const useWebsocketInboundActivityStore = createCounterStore({
  count: 'pendingInbound',
  increment: 'startProcessing',
  decrement: 'endProcessing',
});
