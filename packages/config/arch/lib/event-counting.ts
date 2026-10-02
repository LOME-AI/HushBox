import { Node, SyntaxKind } from 'ts-morph';
import { luaDispatches } from './redis-calls.js';

/**
 * What the event-counting species IS, resolved here for the two rules that
 * refuse it: `event-counting-in-rate-limit` inside `apps/api/src/`, and
 * `event-counting-lives-in-api` outside it. "Is this construct an event
 * counter" is answered here so that it is answered once — a construct one rule
 * reads as counting and the other does not escapes through the gap between
 * them. What the two rules still decide separately is named at the end of this
 * header.
 *
 * THE SPECIES: a Redis counter stepped by exactly one event — `INCR` and
 * `DECR`, plus `INCRBY` / `DECRBY` / `HINCRBY` and the float pair when the
 * amount reads as one. The discriminator is the amount's MAGNITUDE, not the
 * command and not the direction: `HINCRBY key f -1` counts events as
 * `HINCRBY key f 1` does, which is the boundary the sibling
 * `no-lossy-counter-gate` header draws for its own species. An `INCRBY` whose
 * amount is a variable stays out — it folds a quantity into an accumulator,
 * which carries no attempt semantics.
 *
 * The source-text readers those verdicts run on — which dispatch spellings are
 * recognised, which literals are read as scripts, how a template is read, and
 * which member a client call names — read a Redis CALL SITE rather than this
 * species, and live in `redis-calls.ts`, which a third rule refusing a
 * different species reads too.
 *
 * HOW AN AMOUNT IS READ is here too, on both paths: {@link scriptCountsEvents}
 * for a dispatch's argument list, {@link advancesByOne} for a client call's
 * argument node. Each was once each rule's own, and each pair of readings had
 * already diverged into a strict subset. On the script path one stepped over
 * quoted text and one did not, so `redis.call('INCRBY', "attempts)", 1)`
 * counted inside `apps/api/src/` and not outside it. On the client path one
 * read the argument's AST and one read its text, so `.incrby(key, +1)` counted
 * outside `apps/api/src/` and not inside it.
 *
 * WHAT STAYS WITH EACH COUNTING RULE: which files it reads, and nothing about
 * what counts as a step.
 */

/** Commands that step a counter by themselves, needing no amount argument. */
const STEP_COMMANDS = new Set(['incr', 'decr']);

/**
 * The commands that carry their amount as an argument. The float pair counts
 * the same events by the same construct — a limiter advancing by `1.0` is a
 * limiter — so the amount, not the command's integer-ness, stays the
 * discriminator. There is no `HDECRBY`: a hash field counts down as
 * `HINCRBY key field -1`, which the magnitude test below catches.
 */
const AMOUNT_COMMANDS = new Set(['incrby', 'decrby', 'hincrby', 'incrbyfloat', 'hincrbyfloat']);

/** `'1'` → `1`; Redis takes an amount as a string and means the same by it. */
function unquote(text: string): string {
  const quote = text.at(0);
  if ((quote === "'" || quote === '"') && text.length >= 2 && text.at(-1) === quote) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * An amount of one event, however it is spelled: `1`, `'1'`, `1.0`, `-1`.
 * MAGNITUDE, because direction is not part of the shape — `HINCRBY key f -1`
 * counts the same events as `HINCRBY key f 1`.
 */
export function isOne(text: string): boolean {
  const amount = unquote(text.trim());
  return Math.abs(Number(amount)) === 1;
}

/** The signs an amount may carry; either leaves the magnitude the operand's. */
const SIGN_TOKENS: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.MinusToken, SyntaxKind.PlusToken]);

/**
 * Whether a client call's amount ARGUMENT NODE steps by one — the same
 * question {@link isOne} answers about a script's amount text, read off the
 * AST because a client call has one.
 *
 * Reading the node rather than its text is what keeps a sign, a quote and a
 * decimal from each needing their own text case: `+1`, `-1` and `- 1` are one
 * shape to the parser and three to a string reader, and the two rules that ask
 * this question disagreed on exactly that difference while each read the
 * argument its own way.
 */
export function advancesByOne(amount: Node | undefined): boolean {
  if (Node.isPrefixUnaryExpression(amount)) {
    return SIGN_TOKENS.has(amount.getOperatorToken()) && advancesByOne(amount.getOperand());
  }
  if (Node.isNumericLiteral(amount)) return amount.getLiteralValue() === 1;
  return Node.isStringLiteral(amount) && isOne(amount.getLiteralText());
}

/** Stepping a counter by exactly one, whatever the command is called. */
export function isEventStep(command: string, stepsByOne: boolean): boolean {
  if (STEP_COMMANDS.has(command)) return true;
  return AMOUNT_COMMANDS.has(command) && stepsByOne;
}

const QUOTES = new Set(["'", '"']);

type CharRole =
  | 'quote-start'
  | 'quote-end'
  | 'open'
  | 'close'
  | 'separator'
  | 'terminator'
  | 'plain';

/** What a character means while the scan sits inside a quoted argument. */
function quotedRole(char: string, quote: string): CharRole {
  return char === quote ? 'quote-end' : 'plain';
}

/** What one character means to the argument scan, given where the scan is. */
function roleOf(
  char: string,
  depth: number,
  quote: string | undefined,
  quotesTracked: boolean
): CharRole {
  if (quote !== undefined) return quotedRole(char, quote);
  if (quotesTracked && QUOTES.has(char)) return 'quote-start';
  if (char === '(') return 'open';
  if (char === ')') return depth > 0 ? 'close' : 'terminator';
  if (char === ',' && depth === 0) return 'separator';
  return 'plain';
}

/**
 * One pass of the argument split, from the character after the command name.
 * Parens are stepped over, so a call or a concatenation in the KEY or FIELD
 * position does not end the scan before the amount that follows it:
 * `redis.call('INCRBY', redis.call('GET', KEYS[1]), 1)` counts one event, and a
 * scan stopping at the inner `)` reads `KEYS[1]` as the amount. With
 * `quotesTracked`, quoted text is stepped over too; without it, quote
 * characters are ordinary text. A dispatch whose text ends before its own `)`
 * (cut off by concatenation) yields what it has, so an `INCR` fragment still
 * counts.
 */
function scanArguments(text: string, start: number, quotesTracked: boolean): string[] {
  const argumentsFound: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | undefined;
  for (const char of text.slice(start)) {
    switch (roleOf(char, depth, quote, quotesTracked)) {
      case 'terminator': {
        argumentsFound.push(current);
        return argumentsFound;
      }
      case 'separator': {
        argumentsFound.push(current);
        current = '';
        continue;
      }
      case 'quote-start': {
        quote = char;
        break;
      }
      case 'quote-end': {
        quote = undefined;
        break;
      }
      case 'open': {
        depth += 1;
        break;
      }
      case 'close': {
        depth -= 1;
        break;
      }
      default: {
        break;
      }
    }
    current += char;
  }
  argumentsFound.push(current);
  return argumentsFound;
}

/**
 * Both readings of one dispatch's arguments: quote-tracking, and quote-blind.
 * The caller counts when EITHER reading counts an event.
 *
 * The design intent: quote-blind is meant to stay a floor that the
 * quote-tracking refinement does not fall below. Running both unconditionally
 * is how that intent is pursued here. An earlier version ran the refined split
 * and fell back only when it detected an unbalanced quote; that detector read
 * parity, so two lone quotes in one script re-balanced it and the fallback did
 * not run. This version has no detector.
 *
 * Both readings earn their place. A backslash is not interpreted, so an escaped
 * quote in the scanned text (`'user\'s'`) and the bare apostrophe a JS template
 * leaves after cooking that backslash away (`'user's'`) are read by the
 * quote-blind pass; a key containing a paren (`"attempts)"`) is read by the
 * quote-tracking one.
 */
function argumentReadings(text: string, start: number): string[][] {
  return [scanArguments(text, start, true), scanArguments(text, start, false)];
}

/** The trailing argument of a call — the amount, for the amount-carrying family. */
function lastArgument(argumentsFound: readonly string[]): string {
  return argumentsFound.findLast((argument) => argument.trim() !== '')?.trim() ?? '';
}

/** Whether an embedded script's text steps a counter by exactly one event. */
export function scriptCountsEvents(text: string): boolean {
  return luaDispatches(text).some((dispatch) =>
    argumentReadings(text, dispatch.argumentsAt).some((dispatchArguments) =>
      isEventStep(dispatch.command, isOne(lastArgument(dispatchArguments)))
    )
  );
}
