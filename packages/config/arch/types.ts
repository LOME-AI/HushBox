import type { Project } from 'ts-morph';

/** A single structural-rule violation, pointing at the offending location. */
export interface ArchViolation {
  file: string;
  line: number;
  message: string;
}

/**
 * A structural architecture rule the lint layer cannot express.
 *
 * Rules default to syntax and resolve — symbols, aliases, module specifiers —
 * where the invariant cannot be read off syntax alone. That is permitted, and
 * its cost is one-time for the run rather than per-rule: every rule is handed
 * the same {@link Project}, so whatever resolution builds is built once and
 * shared, however many rules reach it.
 *
 * Which rules resolve is deliberately not recorded here, because it is not
 * readable: an ordinary-looking accessor can reach the checker (a declaration's
 * export check falls back to the symbol when there is no `export` keyword), and
 * a resolve path behind an early return can sit unused for a whole run. Only
 * instrumenting a run answers it.
 */
export interface ArchRule {
  name: string;
  check(project: Project): ArchViolation[];
}

/** A violation paired with the rule that produced it. */
export interface ArchRuleResult {
  rule: string;
  violation: ArchViolation;
}
