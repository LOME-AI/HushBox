/**
 * Run the main async action of a CLI script with shared error handling.
 *
 * Resolved number: process exits with that code.
 * Anything else (or no return): process exits with code 0.
 * Thrown error: prints the message to stderr and exits with code 1.
 *
 * Used by every CLI entry point in scripts/ so the error-handling pattern
 * stays consistent.
 */
export async function runMain(action: () => unknown): Promise<void> {
  try {
    const result = await action();
    process.exit(typeof result === 'number' ? result : 0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
