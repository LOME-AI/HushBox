import { createCounterStore } from './create-counter-store.js';

export const useDecryptionActivityStore = createCounterStore({
  count: 'pendingDecryptions',
  increment: 'markPending',
  decrement: 'markComplete',
});
