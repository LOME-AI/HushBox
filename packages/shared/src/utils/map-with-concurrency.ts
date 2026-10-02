/**
 * Runs `run` over `items` with at most `limit` in flight, returning results in
 * input order (never completion order) so callers can line results up with
 * their inputs. A rejected `run` rejects the whole call; mappers already in
 * flight are not cancelled.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  // One iterator shared by every worker: handout is synchronous and yields the
  // element itself, so no two workers claim the same item and every slot of
  // `results` is assigned exactly once.
  const pending = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) {
      results[index] = await run(item, index);
    }
  };
  const width = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
