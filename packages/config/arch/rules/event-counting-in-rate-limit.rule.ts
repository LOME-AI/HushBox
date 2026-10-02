import { SyntaxKind } from 'ts-morph';
import { advancesByOne, isEventStep, scriptCountsEvents } from '../lib/event-counting.js';
import { isTestFile, relativePath } from '../lib/paths.js';
import { calledMember, scriptLiterals } from '../lib/redis-calls.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * There is one event-counting implementation in the repo and it lives in
 * `apps/api/src/lib/rate-limit`. A second one is not a duplicated helper — it
 * is a second answer to "how many attempts has this identity spent", and the
 * two answers drift the moment one of them counts a refusal the other does not.
 *
 * THE SPECIES THIS REFUSES is the one `lib/event-counting.ts` states, which the
 * sibling `event-counting-lives-in-api` rule resolves from that same module: a
 * Redis counter stepped by exactly one event, discriminated by the AMOUNT's
 * MAGNITUDE rather than by the command or the direction. That last point is
 * deliberate agreement with the sibling `no-lossy-counter-gate` rule, whose
 * header rules the same for its own species: a gate that counts down races
 * exactly as one that counts up.
 *
 * The quantity the magnitude test keeps out is settled provider spend in
 * nano-USD, folded into an accumulator by an `INCRBY` whose amount is a
 * variable — a different quantity with a different cap and no attempt
 * semantics at all.
 *
 * Both spellings of the step are read: the client call (`redis.incr`) and the
 * Lua one inside an embedded script, which type-aware tooling reads as a
 * string. The Lua side takes the dispatch spellings `lib/redis-calls.ts`
 * matches, rather than one house style, and an amount of one however
 * `lib/event-counting.ts`'s magnitude test spells it. A template is read as ONE script with its
 * holes stood in for, and a dispatch is recognised from its opening, so a
 * fragment carrying no closing paren of its own still counts. A script literal
 * is judged on its own text.
 *
 * How an amount is read — a dispatch's arguments and a client call's argument
 * node alike — is `lib/event-counting.ts`'s, not this rule's: the sibling
 * `event-counting-lives-in-api` reads them the same way, so a step one refuses
 * is a step the other refuses. It was not always so, in both directions: this
 * rule read a dispatch's arguments twice and the sibling once, while the
 * sibling read a client amount as text and this rule read it off the AST.
 *
 * WHAT THIS DOES NOT SEE. REPRESENTATIVE, NOT EXHAUSTIVE — this is static
 * analysis over source text, so the set of spellings is unbounded and no list
 * can close it. These are the shapes worth knowing about; a construct nobody
 * would write is out of scope rather than a gap:
 * - An amount of one the rule cannot read as a literal: interpolated, computed
 *   (`tonumber(ARGV[1])`), or cut off its own dispatch by concatenation. The
 *   command name alone is enough for `INCR` and `DECR`, so this shelters only
 *   the amount-carrying family `lib/event-counting.ts` names.
 * - The fused spelling `redis.call('INCRBY', KEYS[1], redis.call('SETNX',
 *   KEYS[2], 1))` — `if SETNX == 1 then INCR` written as one dispatch. Inside
 *   the species and left open deliberately: the inner `1` is the SETNX value,
 *   not the outer amount, and no reading of the argument text tells them apart.
 * - A client method named by a computed index (`redis[command](key)`), and its
 *   mirror in Lua: a dispatch whose COMMAND is a variable rather than a quoted
 *   name (`redis.call(ARGV[1], KEYS[1])`).
 * - A script in no in-scope file — outside `apps/api/src`, or assembled at
 *   runtime out of values rather than written as text.
 * - A sorted-set sliding window (`ZADD` + `ZCARD`), which counts events without
 *   ever stepping an integer.
 */

const MESSAGE =
  "a hand-rolled event counter outside lib/rate-limit — count attempts through `consume`, the repo's only counting implementation, which admits exactly maxAttempts per window under any concurrency.";

function isInScope(filePath: string): boolean {
  if (!filePath.includes('apps/api/src/')) return false;
  if (isTestFile(filePath)) return false;
  return !filePath.includes('apps/api/src/lib/rate-limit/');
}

/**
 * Client-side `<something>.incr(key)` / `.incrby(key, 1)` /
 * `.hincrby(key, field, 1)`, the float pair, and the countdown spellings
 * (`.decr(key)`, `.decrby(key, 1)`, `.incrby(key, -1)`), on the same amount
 * test as the Lua path.
 */
function clientSteps(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      const name = calledMember(call)?.name;
      if (name === undefined) return false;
      return isEventStep(name.toLowerCase(), advancesByOne(call.getArguments().at(-1)));
    })
    .map((call) => ({ file: filePath, line: call.getStartLineNumber(), message: MESSAGE }));
}

/** Lua `INCR` inside an embedded script literal. */
function scriptSteps(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  return scriptLiterals(sourceFile)
    .filter((script) => scriptCountsEvents(script.text))
    .map((script) => ({
      file: filePath,
      line: script.node.getStartLineNumber(),
      message: MESSAGE,
    }));
}

const rule: ArchRule = {
  name: 'event-counting-in-rate-limit',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!isInScope(filePath)) continue;
      violations.push(...clientSteps(sourceFile, filePath), ...scriptSteps(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
