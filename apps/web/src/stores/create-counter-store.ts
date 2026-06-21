import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';

/**
 * Names the public surface of a non-negative activity counter store: which key
 * holds the live count, and which keys expose the increment/decrement actions.
 * Lets the three activity stores (decryption, streaming, websocket inbound)
 * share one counter implementation while keeping domain-specific public APIs.
 */
interface CounterConfig<Count extends string, Increment extends string, Decrement extends string> {
  count: Count;
  increment: Increment;
  decrement: Decrement;
}

type CounterState<
  Count extends string,
  Increment extends string,
  Decrement extends string,
> = Record<Count, number> & Record<Increment | Decrement, () => void>;

export function createCounterStore<
  Count extends string,
  Increment extends string,
  Decrement extends string,
>(
  config: CounterConfig<Count, Increment, Decrement>
): UseBoundStore<StoreApi<CounterState<Count, Increment, Decrement>>> {
  const { count, increment, decrement } = config;
  type State = CounterState<Count, Increment, Decrement>;

  return create<State>()((set) => {
    const state = {
      [count]: 0,
      [increment]: () => {
        set((previous) => ({ [count]: (previous[count] as number) + 1 }) as Partial<State>);
      },
      [decrement]: () => {
        set(
          (previous) =>
            ({ [count]: Math.max(0, (previous[count] as number) - 1) }) as Partial<State>
        );
      },
    };
    return state as State;
  });
}
