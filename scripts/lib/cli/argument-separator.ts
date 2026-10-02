/**
 * The `--` pnpm keeps, for every script wrapper that has to answer for one.
 *
 * pnpm appends a caller's extra arguments to the end of the script's command
 * string with the separator left in place, unlike npm, which strips it, so the
 * separator reaches the wrapped tool's own parser rather than stopping at
 * pnpm. What it costs there is the tool's own grammar, which is why this module
 * is tool-neutral and each wrapper decides: Playwright reads what follows one
 * as positional path regexes and answers for them, while vitest collects them
 * into a bucket it never reads.
 */

/** The end-of-options separator, as the shell and pnpm spell it. */
export const ARGUMENT_SEPARATOR = '--';

/**
 * The slots a bare separator hides from vitest's parser, quoted for a refusal
 * that names them, or `null` when it hides nothing — no separator present, or
 * one trailing with nothing behind it to drop.
 *
 * Those slots reach neither a filter nor a flag: nothing scopes the run, it
 * widens to everything the config collects, and it still exits 0. So a wrapper
 * that hands vitest a separator has already lost the arguments, and the loss is
 * silent — which is why each one refuses instead, naming what would have gone.
 */
export function slotsHiddenBySeparator(args: readonly string[]): string | null {
  const terminator = args.indexOf(ARGUMENT_SEPARATOR);
  const dropped = terminator === -1 ? [] : args.slice(terminator + 1);
  return dropped.length === 0 ? null : dropped.map((slot) => '`' + slot + '`').join(', ');
}

/**
 * Argv with the separator pnpm keeps ahead of a caller's arguments removed.
 * Only the first goes: a later one is the caller's own, and what it means is
 * the wrapped tool's business — Playwright reads one and answers for it, where
 * the vitest wrappers refuse it rather than hand it over.
 */
export function stripFirstSeparator(args: readonly string[]): readonly string[] {
  const separator = args.indexOf(ARGUMENT_SEPARATOR);
  return separator === -1 ? [...args] : [...args.slice(0, separator), ...args.slice(separator + 1)];
}
