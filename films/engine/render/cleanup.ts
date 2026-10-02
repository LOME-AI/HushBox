/**
 * Runs `work`, then `cleanup` whether `work` resolved or rejected. A cleanup
 * failure never replaces the work's own failure, which names what broke: the
 * work's error is the one thrown, with the cleanup failure as its cause (beside
 * any cause it already had). A work failure that is no Error cannot carry a
 * cause, so the two travel together in an AggregateError.
 */
export async function thenCleanUp<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (!(error instanceof Error)) {
        throw new AggregateError([error, cleanupError], 'the work failed, then its cleanup');
      }
      error.cause =
        error.cause === undefined
          ? cleanupError
          : new AggregateError(
              [error.cause, cleanupError],
              'the failure had its own cause, then its cleanup failed'
            );
    }
    throw error;
  }
  await cleanup();
  return result;
}
