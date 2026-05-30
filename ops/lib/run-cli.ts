/**
 * Tiny CLI argv parser shared by ops scripts.
 *
 * Mirrors `scripts/lib/run-cli.ts` to keep ops self-contained — avoids
 * cross-workspace relative imports that confuse tsgo's type resolution.
 * The two copies are intentionally identical; if the contract changes,
 * promote it to a shared workspace package and import from both sides.
 */
export function parseOrExit<T>(
  parser: (args: string[]) => T | { error: string },
  args: string[] = process.argv.slice(2)
): T {
  const result = parser(args);
  if (typeof result === 'object' && result != null && 'error' in result) {
    console.error((result as { error: string }).error);
    process.exit(1);
  }
  return result;
}
