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
