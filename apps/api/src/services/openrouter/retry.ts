export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Retry an async function with exponential backoff.
 * By default retries all errors. Pass `shouldRetry` to filter which errors trigger retry.
 */
export async function retryWithBackoff<T>(
  function_: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 4000,
    shouldRetry = (): boolean => true,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await function_();
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !shouldRetry(error)) {
        throw error;
      }
      const delay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('retryWithBackoff: unreachable');
}

/**
 * Check if an error is a transient OpenRouter provider error (suitable for retry).
 */
export function isProviderError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('OpenRouter error:');
}
