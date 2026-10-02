import { SyntaxKind } from 'ts-morph';
import { advancesByOne, isEventStep, scriptCountsEvents } from '../lib/event-counting.js';
import { isTestFile, relativePath } from '../lib/paths.js';
import { calledMember, scriptLiterals } from '../lib/redis-calls.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Event counting lives in `apps/api/src/`. The repo's one counting
 * implementation is `apps/api/src/lib/rate-limit`, and a second answer to "how
 * many attempts has this identity spent" drifts from the first the moment one
 * counts a refusal the other does not. Three sibling rules hold that line
 * inside the api tree; this one refuses that shape everywhere else, so a counter
 * written into a package and driven from the worker is caught where it is
 * written, to the reach the residual list below bounds.
 *
 * WHY A SEPARATE RULE RATHER THAN A WIDER GATE ON THE SIBLINGS. Their stated
 * remedy is "count through `lib/rate-limit`", which a package cannot take:
 * Redis and Drizzle live in the worker and packages never import apps. Widening
 * them would ship a rule whose fix is unreachable from the tree it fires on.
 * This rule's remedy is reachable from every tree it scans — move the code into
 * `apps/api/src/`.
 *
 * THE SPECIES IT REFUSES is the one `lib/event-counting.ts` states, which the
 * sibling `event-counting-in-rate-limit` rule resolves from that same module: a
 * Redis counter stepped by exactly one event, discriminated by the amount's
 * MAGNITUDE rather than by the command or the direction. How an amount is read
 * — a script's dispatch arguments and a client call's argument node alike —
 * comes from that module too, so a step this rule refuses is a step the sibling
 * refuses; it was not always so, and while the two readings were each rule's
 * own each was a strict subset of the other on one of the two paths. What is
 * this rule's own is the reach below — which files it reads, and the residual
 * list at the end of this header.
 *
 * Both spellings of the step are read: the client call and the Lua dispatch
 * inside an embedded script literal, each recognised by the dispatch readers
 * `lib/redis-calls.ts` holds rather than by one house style. A template is
 * read as ONE script with its holes stood in for. A script literal is judged
 * on its own text, so a package exporting a script string for the worker to run
 * is flagged where the string is written. A dispatch's match ends at the command
 * name, so a dispatch nested in another's argument list is read in its own right.
 * Repeat findings on one line collapse to a single violation.
 *
 * WHAT THIS DOES NOT SEE. REPRESENTATIVE, NOT EXHAUSTIVE — this is static
 * analysis over source text, so the set of spellings is unbounded and no list
 * closes it. These are the shapes worth knowing about; a construct nobody would
 * write is out of scope rather than a gap:
 * - An amount this rule cannot read as a literal: interpolated, computed, or cut
 *   off its own dispatch by concatenation. The command name alone carries `INCR`
 *   and `DECR`, so this shelters only the amount-carrying family.
 * - A read-then-write counter gate (`GET`, then `SET` of the value plus one),
 *   which steps no integer command. That is `no-lossy-counter-gate`'s species,
 *   and that rule gates itself to the api tree.
 * - A counter that is not a Redis string or hash: a Postgres row advanced by
 *   `UPDATE … SET attempts = attempts + 1`, an in-process `Map`, or a sorted-set
 *   sliding window (`ZADD` + `ZCARD`), which counts without storing a count.
 * - A dispatch whose command is a variable rather than a quoted name, or a client
 *   method reached by a computed index.
 * - Test files, which are out of scope here as they are in the sibling rules.
 */

const API_SRC = 'apps/api/src/';
const MESSAGE =
  "an event counter outside `apps/api/src/` — move it into `apps/api/src/` and count through lib/rate-limit's `consume`, whose atomic INCR admits exactly maxAttempts under any concurrency. Importing the primitive from here is not the fix: Redis and Drizzle live in the worker, so a package cannot reach it.";

function isInScope(filePath: string): boolean {
  return !filePath.includes(API_SRC) && !isTestFile(filePath);
}

/** Lines carrying a client-side step: `redis.incr(key)`, `redis.hincrby(key, f, -1)`. */
function clientStepLines(sourceFile: SourceFile): number[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      const name = calledMember(call)?.name;
      if (name === undefined) return false;
      return isEventStep(name.toLowerCase(), advancesByOne(call.getArguments().at(-1)));
    })
    .map((call) => call.getStartLineNumber());
}

function scriptStepLines(sourceFile: SourceFile): number[] {
  return scriptLiterals(sourceFile)
    .filter((script) => scriptCountsEvents(script.text))
    .map((script) => script.node.getStartLineNumber());
}

const rule: ArchRule = {
  name: 'event-counting-lives-in-api',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!isInScope(filePath)) continue;
      const lines = new Set([...clientStepLines(sourceFile), ...scriptStepLines(sourceFile)]);
      for (const line of [...lines].toSorted((a, b) => a - b)) {
        violations.push({ file: filePath, line, message: MESSAGE });
      }
    }
    return violations;
  },
};

export default rule;
