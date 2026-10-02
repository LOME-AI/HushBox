/**
 * Tool arguments every lint invocation that has to be able to fail a build
 * passes to ESLint.
 *
 * ESLint exits zero on any number of warnings, so a warn-level rule and a stale
 * disable directive fail nothing unless `--max-warnings=0` reaches the CLI. The
 * shared config carries the rules it enables at error severity, so over the
 * files it reads a linter run nobody wrapped — a package's own `eslint .`, the
 * editor — resolves the same rules at the same severities the gate applies.
 * That equalizes rule set and severity, never coverage: the gate lints every
 * lint root, so a green unwrapped run still speaks only for the files it read.
 * This flag is the backstop for a warn-level rule a plugin upgrade introduces,
 * which severity promotion alone gives up.
 *
 * Shared rather than restated at each caller: a copy that drifted would put a
 * scoped lint and the gate back on different rule sets, which is the divergence
 * both mechanisms exist to close.
 */
export const LINT_TOOL_ARGS: readonly string[] = ['--max-warnings=0'];
