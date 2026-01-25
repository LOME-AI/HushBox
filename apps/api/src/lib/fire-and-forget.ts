/**
 * Fire-and-forget utility for non-blocking async operations.
 * Handles errors gracefully without blocking the main execution flow.
 *
 * Use for side effects that shouldn't block the response:
 * - Lazy database updates (e.g., resetting counters)
 * - Background cleanup tasks
 * - Non-critical logging or analytics
 *
 * @param promise - The promise to execute without awaiting
 * @param errorContext - Description of the operation for error logging
 */
export function fireAndForget<T>(promise: Promise<T>, errorContext: string): void {
  void (async () => {
    try {
      await promise;
    } catch (error: unknown) {
      console.error(`Failed to ${errorContext}:`, error);
    }
  })();
}
