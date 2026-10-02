import { Node, SyntaxKind } from 'ts-morph';
import { isRepoPath, isTestFile, relativePath } from '../lib/paths.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The wire codes a client money guard reads as PROOF that a request never
 * reached its handler are minted by the pipeline stage and by nothing else.
 *
 * `apps/web`'s card-payment form offers a re-submit — a fresh idempotency key
 * the server cannot dedup against an earlier attempt — on a refusal whose code
 * says the charge was never dispatched. That is safe only while no handler can
 * produce the same code AFTER doing work; the card-processor adapter answers a
 * generic unavailability after an approved charge, which is exactly the shape
 * that would make a real unknown look safe. Nothing in the type system says a
 * handler may not name the code, so this rule says it.
 *
 * The guard reads a PAIR of status-and-code, so both of its codes are guarded:
 * `RATE_LIMIT_UNAVAILABLE`, which exists for that one caller and is therefore
 * banned across the whole Worker, and `RATE_LIMITED`, which handlers in other
 * slices legitimately answer from inside themselves and is therefore banned
 * only in the slice serving the card-charge route. That asymmetry is what
 * `scope` on each row carries; a tree-wide ban on the second would refuse every
 * correct in-handler refusal the Worker already answers.
 *
 * Two arms, because there are two ways a handler comes to answer one:
 *
 * 1. NAMING it — `ERROR_CODES.<code>` or the bare string — anywhere in the
 *    row's tree but the one file that mints it.
 * 2. CALLING a producer that emits it with the code spelled nowhere near the
 *    call. Two shapes are live: the pipeline's own stamping function reached
 *    from outside the pipeline — a limiter layer counted inside a handler would
 *    route a real refusal through the permitted minter, and the counting layer
 *    already models an in-handler count — and the `rate_limited` domain-error
 *    factory, whose kind the taxonomy projects onto the wire code with no
 *    spelling of it anywhere on the path.
 *
 * What it does NOT catch, stated rather than glossed, because a rule whose name
 * outruns its check is worse than a narrow one:
 *
 * - A reference that is not written out: `ERROR_CODES[key]` for a computed
 *   `key`, or a code reaching a response through a variable this rule never
 *   resolves. It reads the written forms.
 * - A domain error built as an object literal — `{ code: 'rate_limited', … }`
 *   — rather than through its factory. The taxonomy KIND is not a guarded code
 *   and is not banned; only the factory name is.
 * - A guarded slice DELEGATING to a helper in another tree that mints the
 *   refusal itself. Each such helper needs its own producer row; nothing here
 *   discovers one.
 * - WHERE a permitted caller runs. `apps/api/src/middleware/` is read as the
 *   pipeline because that is what it is; a middleware mounted to run after a
 *   handler would satisfy this rule and break the premise, and route ordering
 *   is not syntax.
 * - The route, as opposed to the slice. A scope is a directory, so the
 *   `RATE_LIMITED` row covers every billing route rather than the charge route
 *   alone. That over-reach is the safe direction and the slice is at zero today.
 * - Anything on the `apps/web` side. That the client still pairs the code with
 *   its status, and still dispatches exactly one request per attempt, is pinned
 *   in that package's own tests.
 */

/** The widest tree either arm watches: the product Worker's source, tests excluded. */
const SCANNED_TREE = 'apps/api/src/';

/** The pipeline: the one place a refusal that promises an unrun handler comes from. */
const MINTING_DIRECTORY = 'apps/api/src/middleware/';

/**
 * A code a money guard trusts, the one file permitted to name it, and the tree
 * the ban covers. `scope` is what lets one property hold two codes with
 * opposite reach: a code minted for one caller is banned across the whole
 * Worker, while a code with legitimate producers elsewhere is banned only in
 * the tree that serves the guarded route.
 *
 * Extended by adding a row, never by adding a second rule — the property is one
 * property, and two rules covering it drift apart the moment one is edited.
 */
interface GuardedCode {
  readonly code: string;
  readonly mintedIn: string;
  readonly scope: string;
}

const GUARDED_CODES: readonly GuardedCode[] = [
  {
    code: 'RATE_LIMIT_UNAVAILABLE',
    mintedIn: 'apps/api/src/middleware/rate-limit.ts',
    scope: SCANNED_TREE,
  },
  {
    // The over-cap half of the same guard, and the reason `scope` exists:
    // routes in other slices answer this code from INSIDE their handlers, which
    // is legitimate and stays legitimate, so the ban reaches only the slice
    // serving the card-charge route.
    code: 'RATE_LIMITED',
    mintedIn: 'apps/api/src/middleware/rate-limit.ts',
    scope: 'apps/api/src/slices/billing/',
  },
];

/**
 * A function that produces a guarded code without naming it, the tree the ban
 * covers, and the directory whose files may call it. Extended alongside
 * {@link GUARDED_CODES} when a new code arrives with a producer of its own.
 *
 * This arm is not a duplicate of the naming arm: a guarded code reaches a
 * response through a producer with the code spelled nowhere near the call, so
 * the naming arm cannot see it.
 */
interface GuardedProducer {
  readonly callee: string;
  readonly scope: string;
  readonly permittedDirectory: string;
}

const GUARDED_PRODUCERS: readonly GuardedProducer[] = [
  { callee: 'rateLimitRefusal', scope: SCANNED_TREE, permittedDirectory: MINTING_DIRECTORY },
  {
    // The domain-error factory whose kind projects onto `RATE_LIMITED` through
    // `DOMAIN_ERROR_CODE_TO_WIRE_CODE`. A billing domain function returning one
    // answers the guarded code from inside the handler while spelling it
    // nowhere, which is the widening the naming arm alone would admit.
    callee: 'rateLimitedError',
    scope: 'apps/api/src/slices/billing/',
    permittedDirectory: MINTING_DIRECTORY,
  },
];

function isScanned(filePath: string): boolean {
  return filePath.includes(SCANNED_TREE) && !isTestFile(filePath);
}

/** Arm 1: the code named anywhere in its guarded tree but its minting file. */
function codesNamedOutsideTheirMinter(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const guarded of GUARDED_CODES) {
    if (!filePath.includes(guarded.scope)) continue;
    if (isRepoPath(filePath, guarded.mintedIn)) continue;
    for (const node of namingSites(sourceFile, guarded.code)) {
      violations.push({
        file: filePath,
        line: node.getStartLineNumber(),
        message: `${guarded.code} named in ${guarded.scope} outside ${guarded.mintedIn} — apps/web's card-payment form reads this code as proof the charge was never dispatched and offers a fresh-key re-submit, so a handler that can answer it turns a real unknown into a second charge.`,
      });
    }
  }
  return violations;
}

/** Every written-out reference to a code: the registry access and the bare string. */
function namingSites(sourceFile: SourceFile, code: string): Node[] {
  const sites: Node[] = [];
  for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getName() === code) sites.push(access);
  }
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    if (literal.getLiteralText() === code) sites.push(literal);
  }
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    if (literal.getLiteralText() === code) sites.push(literal);
  }
  return sites;
}

/** Arm 2: the stamping producer called from outside the pipeline. */
function producersCalledOutsideThePipeline(
  sourceFile: SourceFile,
  filePath: string
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee)) continue;
    const producer = GUARDED_PRODUCERS.find((candidate) => candidate.callee === callee.getText());
    if (producer === undefined) continue;
    if (!filePath.includes(producer.scope)) continue;
    if (filePath.includes(producer.permittedDirectory)) continue;
    violations.push({
      file: filePath,
      line: call.getStartLineNumber(),
      message: `${producer.callee}() called in ${producer.scope} outside ${producer.permittedDirectory} — it produces a code apps/web's card-payment form reads as proof the charge was never dispatched, and a caller inside a handler makes that proof false.`,
    });
  }
  return violations;
}

const rule: ArchRule = {
  name: 'money-guard-codes-come-from-the-pipeline',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!isScanned(filePath)) continue;
      violations.push(
        ...codesNamedOutsideTheirMinter(sourceFile, filePath),
        ...producersCalledOutsideThePipeline(sourceFile, filePath)
      );
    }
    return violations;
  },
};

export default rule;
