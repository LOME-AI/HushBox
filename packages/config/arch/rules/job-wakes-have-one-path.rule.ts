import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';
import type { CallExpression, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A job enqueued inside a transaction leaves its dispatcher shard on the
 * granting scope's collector, and the runtime boundary that opened that scope
 * nudges the dispatcher once the transaction has committed. The nudge buys
 * enqueue-to-first-attempt latency and nothing else — the dispatcher's
 * perpetual alarm is the delivery guarantee — so a wake that never fires is
 * invisible in every test and in production alike, which is exactly how the
 * hand-rolled wakes this capability replaced came to be forgotten at three
 * call sites.
 *
 * The capability's reach is already a compile error to skip: `enqueueWithinTx`
 * demands a capability-bearing handle, so a context that never mints one cannot
 * enqueue at all. THREE THINGS THE TYPE SYSTEM STILL CANNOT SAY are the three
 * clauses here, and each is a way of satisfying the compiler while dropping the
 * wake.
 *
 * 1. MINTING WITHOUT DISCHARGING. A scope that mints a collector satisfies
 *    every signature downstream of it; whether it ever fires what it collected
 *    is a fact about that scope's own body, which no signature reaches. This is
 *    the original defect wearing the new capability's clothes.
 * 2. FORGING THE BRAND. `JobWakeCapable<T>` is an intersection over a
 *    module-private symbol, so `grantJobWakes` is the only thing that can
 *    produce one — except that a type assertion produces one too, out of a
 *    handle carrying no collector at all. That handle then throws inside a
 *    domain transaction rather than dropping a wake, which is louder but is
 *    still a defect no signature refuses.
 * 3. NUDGING BY HAND. The nudge is reachable from anywhere holding the
 *    dispatcher namespace, and `c.env` holds it on every request. A caller that
 *    wakes the dispatcher itself has bypassed the collector, so its wake fires
 *    before its transaction commits — the pre-commit wake is worse than none,
 *    because the dispatcher finds no row and re-arms on its old schedule.
 *
 * WHY THE SUBJECT IS THE MINT AND NOT THE POOL CLOSE. An earlier form of this
 * rule stood over "a file that closes a database connection", on the reasoning
 * that a new runtime boundary must close its pool for hygiene and so enters the
 * subject for free. It does not survive contact with the tree. It is too wide —
 * seed and backup scripts, the migration rehearsal, and the request-scoped test
 * scaffolding all close pools and owe no discharge — and, worse, it is blind in
 * the one direction that matters: a Durable Object holds ONE connection for the
 * object's whole life and never closes it, so the longest-lived context in the
 * system is the one a pool-close subject cannot see. Minting is the act that
 * incurs the obligation, so it is the act the rule stands over.
 *
 * WHY NOT LINT. Clauses 1 and 3 are properties of a whole scope and of the
 * repository's call graph — where a discharge sits relative to a mint, and how
 * many callers a capability has — neither of which a per-file lint rule counts.
 * Clause 2 alone is a syntactic pattern lint could express, and it sits here
 * anyway: it is one third of one capability's protection, and splitting it into
 * another layer would file half the reasoning where the other half is not.
 *
 * TEST FILES ARE OUT OF SCOPE. Tests mint collectors to hand to an enqueue and
 * assert on what was collected, forge capable handles to exercise a signature,
 * and call the nudge directly to prove it swallows failures. Every one of those
 * is the test doing its job.
 *
 * WHAT THIS DOES NOT REACH, stated as the residual it is:
 * - A capability that arrives already bound to a local name: a collector, a
 *   `createDispatcherWake` result, or the nudge itself passed in as an argument
 *   or read off an object. Import aliases ARE followed; a value hop is not.
 * - A discharge that is lexically present in the minting scope but unreachable
 *   at runtime — behind a branch that never runs, or after an early return. The
 *   clause asks where the call is written, never whether it executes.
 * - A second capability declared under new names in a new module, which is a
 *   second spelling of the whole protocol rather than a bypass of this one.
 */

const RULE_NAME = 'job-wakes-have-one-path';

/**
 * The rule's abort. Every anchor below is resolved rather than assumed, because
 * a rule that could not find its own subject would report a clean repository
 * forever — the silent narrowing this whole layer exists to refuse.
 */
const fail: (message: string) => never = failWith(RULE_NAME);

/** Where the capability is declared, and the names that spell its protocol. */
const CAPABILITY_MODULE = 'apps/api/src/lib/jobs/wake-capability.ts';
const MINT = 'createJobWakeCollector';
const DISCHARGE = 'dischargeJobWakes';
const CAPABILITY_TYPE = 'JobWakeCapable';
const GRANT = 'grantJobWakes';

/**
 * The merge-on-commit protocol: the one mint that does not discharge, because
 * what it collects moves onto the parent's collector when the body returns and
 * is discharged there. The exemption is this declaration, never its file — a
 * second non-discharging mint declared beside it would otherwise ride the same
 * exemption into silence.
 */
const MERGE_PROTOCOL = 'runWithJobWakes';

/** Where the nudge is declared, and where the factory that binds it is. */
const NUDGE_MODULE = 'apps/api/src/lib/jobs/wake.ts';
const NUDGE = 'wakeJobDispatcher';
const NUDGE_FACTORY_MODULE = 'apps/api/src/lib/jobs/health-entry.ts';
const NUDGE_FACTORY = 'createDispatcherWake';

/** The cron dispatch that wires the jobs-health auditor's own nudge. */
const CRON_MODULE = 'apps/api/src/scheduled.ts';
const CRON_DISPATCH = 'cronEntriesFor';

const MINT_WITHOUT_DISCHARGE = `Mints a job-wake collector in a scope that never calls ${DISCHARGE}. A collector satisfies every signature downstream of it whether or not its shards are ever fired, so a boundary that mints and forgets drops the dispatcher nudge for every job its transactions enqueue — silently, because the dispatcher's alarm still delivers them late. Discharge in the same scope, after the last committing transaction and before the connection it borrowed is gone; a scope that means to merge upward instead runs ${MERGE_PROTOCOL}.`;

const FORGED_CAPABILITY = `Asserts a handle to ${CAPABILITY_TYPE}. The capability is an intersection over a module-private symbol, so ${GRANT} in ${CAPABILITY_MODULE} is the only thing that can put a collector on a handle; an assertion produces the type without the collector, and the first enqueue through that handle throws inside a domain transaction. Take the capability from the scope that minted it — a request handler reads it off the request-scoped handle — rather than asserting it onto one that has none.`;

function handRolledNudge(name: string, homes: string): string {
  return `Calls ${name} outside ${homes}. The dispatcher nudge belongs to a boundary's discharge, which fires it after the collecting transaction has committed; a nudge written at a call site fires before that commit, so the dispatcher wakes, finds no row, and re-arms on its old schedule — a wake worse than none. Enqueue inside the transaction and let the boundary discharge, which is what nudges the dispatcher.`;
}

/** The node kinds that own a body a discharge could sit in. */
const FUNCTION_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.Constructor,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.SetAccessor,
]);

/** Every local name this file binds an export to, the export's own name included. */
function localNamesFor(sourceFile: SourceFile, exportName: string): ReadonlySet<string> {
  const names = new Set<string>([exportName]);
  for (const declaration of sourceFile.getImportDeclarations()) {
    for (const named of declaration.getNamedImports()) {
      if (named.getName() !== exportName) continue;
      const alias = named.getAliasNode();
      if (alias !== undefined) names.add(alias.getText());
    }
  }
  return names;
}

/** The name a call spells for its callee, bare or through a member chain. */
function calleeName(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return undefined;
}

/** Every call inside `scope` whose callee is spelled with one of `names`. */
function callsNamed(scope: Node, names: ReadonlySet<string>): CallExpression[] {
  return scope.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const name = calleeName(call);
    return name !== undefined && names.has(name);
  });
}

/** The nearest ancestor whose body a discharge could be written in. */
function enclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor((ancestor) => FUNCTION_KINDS.has(ancestor.getKind()));
}

/** Whether `node` sits lexically inside `region`, which may be in another file. */
function isInside(node: Node, region: Node): boolean {
  return (
    node.getSourceFile() === region.getSourceFile() &&
    node.getStart() >= region.getStart() &&
    node.getEnd() <= region.getEnd()
  );
}

/** The scanned file at a repo-relative path, or the rule's abort when it has moved. */
function moduleAt(project: Project, repoPath: string): SourceFile {
  const sourceFile = sourceFileAt(project, repoPath);
  if (sourceFile === undefined) {
    fail(
      `'${repoPath}' names no file in the scanned tree, so the job-wake protocol cannot be located. Point this rule at its new home.`
    );
  }
  return sourceFile;
}

/** A function declaration read off a module, or the rule's abort when it has been renamed. */
function functionIn(sourceFile: SourceFile, name: string, repoPath: string): Node {
  const declaration = sourceFile.getFunction(name);
  if (declaration === undefined) {
    fail(
      `${name} is no longer declared in ${repoPath}, so the job-wake protocol cannot be read off it and every clause resting on that name would pass over nothing. Point this rule at its new name.`
    );
  }
  return declaration;
}

/** The branded type's declaration, asserted so a rename cannot silence the forge clause. */
function assertCapabilityTypeDeclared(sourceFile: SourceFile): void {
  if (sourceFile.getTypeAlias(CAPABILITY_TYPE) === undefined) {
    fail(
      `${CAPABILITY_TYPE} is no longer declared in ${CAPABILITY_MODULE}, so an assertion onto the capability could not be recognised anywhere. Point this rule at its new name.`
    );
  }
}

/**
 * Everything the clauses resolve rather than assume: the declarations that must
 * still exist for a clause to mean anything, and the regions inside which the
 * two capabilities may legally be reached.
 */
interface Anchors {
  readonly mergeProtocol: Node;
  readonly nudgeHomes: ReadonlyMap<string, NudgeHome>;
}

/** Where one of the two nudge capabilities may be reached, and how to say so. */
interface NudgeHome {
  readonly regions: readonly Node[];
  readonly described: string;
}

function resolveAnchors(project: Project): Anchors {
  const capability = moduleAt(project, CAPABILITY_MODULE);
  functionIn(capability, MINT, CAPABILITY_MODULE);
  const discharge = functionIn(capability, DISCHARGE, CAPABILITY_MODULE);
  const mergeProtocol = functionIn(capability, MERGE_PROTOCOL, CAPABILITY_MODULE);
  assertCapabilityTypeDeclared(capability);

  functionIn(moduleAt(project, NUDGE_MODULE), NUDGE, NUDGE_MODULE);
  const factory = functionIn(
    moduleAt(project, NUDGE_FACTORY_MODULE),
    NUDGE_FACTORY,
    NUDGE_FACTORY_MODULE
  );
  const cronDispatch = functionIn(moduleAt(project, CRON_MODULE), CRON_DISPATCH, CRON_MODULE);

  return {
    mergeProtocol,
    nudgeHomes: new Map([
      [NUDGE, { regions: [factory], described: `${NUDGE_FACTORY} in ${NUDGE_FACTORY_MODULE}` }],
      [
        NUDGE_FACTORY,
        {
          regions: [discharge, cronDispatch],
          described: `${DISCHARGE} in ${CAPABILITY_MODULE} and ${CRON_DISPATCH} in ${CRON_MODULE}`,
        },
      ],
    ]),
  };
}

/** Mints in this file whose own scope never discharges what they collect. */
function mintViolations(
  sourceFile: SourceFile,
  filePath: string,
  anchors: Anchors
): ArchViolation[] {
  const dischargeNames = localNamesFor(sourceFile, DISCHARGE);
  return callsNamed(sourceFile, localNamesFor(sourceFile, MINT))
    .filter((call) => !isInside(call, anchors.mergeProtocol))
    .filter((call) => {
      const scope = enclosingFunction(call);
      return scope === undefined || callsNamed(scope, dischargeNames).length === 0;
    })
    .map((call) => ({
      file: filePath,
      line: call.getStartLineNumber(),
      message: MINT_WITHOUT_DISCHARGE,
    }));
}

/**
 * Type assertions in this file that produce the capability.
 *
 * Both assertion spellings are read the same way, and the type is matched by
 * IDENTIFIER rather than by the type node's text, so a neighbouring name that
 * merely contains it — the module's own optional-brand read is written over
 * `MaybeJobWakeCapable` — is not swept in. There is no exemption, the owning
 * module included: `${GRANT}` puts the collector on the handle without one
 * today, and a future need for an assertion there is a deliberate re-open
 * rather than a hole standing open in advance.
 */
function forgeViolations(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const names = localNamesFor(sourceFile, CAPABILITY_TYPE);
  const assertions = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression),
  ];
  return assertions
    .filter((assertion) => {
      const typeNode = assertion.getTypeNode();
      return (
        typeNode !== undefined &&
        [typeNode, ...typeNode.getDescendantsOfKind(SyntaxKind.Identifier)].some(
          (node) => Node.isIdentifier(node) && names.has(node.getText())
        )
      );
    })
    .map((assertion) => ({
      file: filePath,
      line: assertion.getStartLineNumber(),
      message: FORGED_CAPABILITY,
    }));
}

/** Reaches for the dispatcher nudge from outside the one path that owns it. */
function nudgeViolations(
  sourceFile: SourceFile,
  filePath: string,
  anchors: Anchors
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const [name, home] of anchors.nudgeHomes) {
    const calls = callsNamed(sourceFile, localNamesFor(sourceFile, name)).filter(
      (call) => !home.regions.some((region) => isInside(call, region))
    );
    for (const call of calls) {
      violations.push({
        file: filePath,
        line: call.getStartLineNumber(),
        message: handRolledNudge(name, home.described),
      });
    }
  }
  return violations;
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    const anchors = resolveAnchors(project);
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (isTestFile(filePath)) continue;
      violations.push(
        ...mintViolations(sourceFile, filePath, anchors),
        ...forgeViolations(sourceFile, filePath),
        ...nudgeViolations(sourceFile, filePath, anchors)
      );
    }
    return violations;
  },
};

export default rule;
