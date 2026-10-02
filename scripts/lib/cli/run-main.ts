/**
 * Every message in the chain, outermost first. A driver failure reaches here
 * wrapped by the layer that issued the statement, so the top message names the
 * statement and the code and the reason live only on the cause — printing the
 * top alone reports a generic connection failure for a specific server error.
 *
 * Exported so a test asserting over what a thrown error puts on stderr calls the
 * function that prints it rather than restating the walk.
 */
export function messageChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (;;) {
    messages.push(current instanceof Error ? current.message : String(current));
    if (!(current instanceof Error)) break;
    seen.add(current);
    const { cause } = current;
    if (cause === undefined || cause === null || seen.has(cause)) break;
    current = cause;
  }
  return messages.join('\ncaused by: ');
}

/**
 * Run the main async action of a CLI script with shared error handling.
 *
 * Resolved number: process exits with that code.
 * Anything else (or no return): process exits with code 0.
 * Thrown error: prints the message and its cause chain to stderr and exits
 * with code 1.
 *
 * Used by every CLI entry point in scripts/ so the error-handling pattern
 * stays consistent.
 */
export async function runMain(action: () => unknown): Promise<void> {
  try {
    const result = await action();
    process.exit(typeof result === 'number' ? result : 0);
  } catch (error: unknown) {
    console.error(messageChain(error));
    process.exit(1);
  }
}
