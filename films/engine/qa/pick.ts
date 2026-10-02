/** The first item whose value is the lowest; null when there are none. */
export function lowestBy<T>(items: Iterable<T>, value: (item: T) => number): T | null {
  let best: T | null = null;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const candidate = value(item);
    if (best === null || candidate < bestValue) {
      best = item;
      bestValue = candidate;
    }
  }
  return best;
}

/** The first item whose value is the highest; null when there are none. */
export function highestBy<T>(items: Iterable<T>, value: (item: T) => number): T | null {
  return lowestBy(items, (item) => -value(item));
}
